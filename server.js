import express from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import dotenv from "dotenv";

dotenv.config();
const deviceLocations = {};

const app = express();
const PORT = process.env.PORT || 3000;

// { "abc123": "photon-living-room", "def456": "photon-bedroom" }
const API_KEY_DEVICE_MAP = Object.fromEntries(
  process.env.DEVICE_KEYS?.split(",").map((entry) => {
    const [key, device] = entry.split(":");
    return [key.trim(), device.trim()];
  }) ?? [],
);

const VALID_API_KEYS = new Set(Object.keys(API_KEY_DEVICE_MAP));

// Middleware: API key auth
function requireApiKey(req, res, next) {
  const key = req.headers["x-api-key"];
  if (!key || !VALID_API_KEYS.has(key)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  req.deviceId = API_KEY_DEVICE_MAP[key]; // available in all route handlers
  next();
}

// Middleware: Rate limiting (per API key, 1 req/min)
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 1,
  keyGenerator: (req) => req.headers["x-api-key"] ?? ipKeyGenerator(req),
  handler: (req, res) => {
    res
      .status(429)
      .json({ error: "Rate limit exceeded. Try again in 1 minute." });
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply auth before rate limiting so invalid keys never consume a slot
app.use(requireApiKey);
app.use(limiter);

app.use(express.json());

// polling logic to check for flights in bounding box for each api/device
import fetch from "node-fetch";
import geoTz from "geo-tz";
import { DateTime } from "luxon";

const OPENSKY_USERNAME = process.env.OPENSKY_USERNAME;
const OPENSKY_PASSWORD = process.env.OPENSKY_PASSWORD;
const POLL_INTERVAL_MS = 60 * 1000; // 1 minute
const ACTIVE_HOURS = { start: 7, end: 23 }; // 7am - 11pm local time

function isWithinActiveHours(lat, lon) {
  const [timezone] = geoTz.find(lat, lon);
  const localHour = DateTime.now().setZone(timezone).hour;
  return localHour >= ACTIVE_HOURS.start && localHour < ACTIVE_HOURS.end;
}
const authHeader =
  "Basic " +
  Buffer.from(`${OPENSKY_USERNAME}:${OPENSKY_PASSWORD}`).toString("base64");

function getBoundingBox(lat, lon, radiusMiles = 20) {
  const milesPerDegLat = 69.0;
  const milesPerDegLon = 69.0 * Math.cos(lat * (Math.PI / 180));
  const deltaLat = radiusMiles / milesPerDegLat;
  const deltaLon = radiusMiles / milesPerDegLon;
  return {
    lamin: lat - deltaLat,
    lamax: lat + deltaLat,
    lomin: lon - deltaLon,
    lomax: lon + deltaLon,
  };
}

async function pollOpenSky(lat, lon, deviceId) {
  if (!isWithinActiveHours(lat, lon)) {
    console.log("Outside active hours, skipping poll");
    return;
  }

  const { lamin, lamax, lomin, lomax } = getBoundingBox(lat, lon);
  const url = `https://opensky-network.org/api/states/all?lamin=${lamin}&lomin=${lomin}&lamax=${lamax}&lomax=${lomax}`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: authHeader },
    });

    if (!res.ok) {
      console.error(`OpenSky error: ${res.status} ${res.statusText}`);
      return;
    }

    const data = await res.json();
    const aircraft = (data.states ?? [])
      .map((s) => ({
        icao24: s[0],
        callsign: s[1]?.trim(),
        lat: s[6],
        lon: s[5],
        altitude: s[7], // meters, baro altitude
        speed: s[9], // m/s
        heading: s[10],
        onGround: s[8],
      }))
      .filter((a) => !a.onGround);

    console.log(`[OpenSky] ${aircraft.length} aircraft overhead`);
    await processOverheadAircraft(aircraft, deviceId);
    return aircraft;
  } catch (err) {
    console.error("[OpenSky] Fetch failed:", err.message);
  }
}

// Start polling loop for a given device
function startPolling(deviceId) {
  const loc = deviceLocations[deviceId];
  if (!loc) {
    console.warn(`No location set for device ${deviceId}, skipping poll`);
    return;
  }

  pollOpenSky(loc.lat, loc.lon, deviceId);

  return setInterval(() => {
    const current = deviceLocations[deviceId];
    if (current) pollOpenSky(current.lat, current.lon, deviceId);
  }, POLL_INTERVAL_MS);
}

const AIRLABS_API_KEY = process.env.AIRLABS_API_KEY;
const MIN_ALTITUDE_FT = 1000;

// Cache: { callsign: { flightInfo, fetchedAt } }
const flightCache = {};
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function metersToFeet(m) {
  return Math.round(m * 3.281);
}
function msToKnots(ms) {
  return Math.round(ms * 1.944);
}

async function fetchFlightInfo(callsign) {
  // Return cached result if still fresh
  const cached = flightCache[callsign];
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.flightInfo;
  }

  try {
    const res = await fetch(
      `https://airlabs.co/api/v9/flight?flight_icao=${callsign}&api_key=${AIRLABS_API_KEY}`,
    );
    if (!res.ok) {
      console.error(`[Airlabs] Error for ${callsign}: ${res.status}`);
      return null;
    }

    const data = await res.json();
    const f = data.response;
    if (!f) return null;

    const info = {
      flightIata: f.flight_iata,
      flightIcao: f.flight_icao,
      airline: f.airline_name,
      depIata: f.dep_iata,
      depName: f.dep_name,
      arrIata: f.arr_iata,
      arrName: f.arr_name,
      depTime: f.dep_time,
      arrTime: f.arr_time,
      status: f.status,
    };

    flightCache[callsign] = { flightInfo: info, fetchedAt: Date.now() };
    return info;
  } catch (err) {
    console.error(`[Airlabs] Fetch failed for ${callsign}:`, err.message);
    return null;
  }
}

// async function processOverheadAircraft(aircraft) {
//   const overhead = aircraft.filter(
//     (a) => metersToFeet(a.altitude) >= MIN_ALTITUDE_FT,
//   );

//   for (const plane of overhead) {
//     if (!plane.callsign) continue;

//     const info = await fetchFlightInfo(plane.callsign);
//     const altFt = metersToFeet(plane.altitude);
//     const knots = msToKnots(plane.speed);

//     if (info) {
//       console.log(`
// --- Flight Overhead ---
// ${info.flightIata ?? plane.callsign}  ${info.airline ?? "Unknown Airline"}
// ${info.depIata} → ${info.arrIata}
// Alt: ${altFt}ft  Hdg: ${Math.round(plane.heading)}°
// Spd: ${knots}kts
// Dep: ${info.depTime}  Arr: ${info.arrTime}
// Status: ${info.status}
// ----------------------`);
//     } else {
//       // Airlabs had nothing — print what we have from OpenSky
//       console.log(`
// --- Flight Overhead (partial) ---
// Callsign: ${plane.callsign}
// Alt: ${altFt}ft  Hdg: ${Math.round(plane.heading)}°
// Spd: ${knots}kts
// ---------------------------------`);
//     }
//   }
// }

async function processOverheadAircraft(aircraft, deviceId) {
  const overhead = aircraft.filter(
    (a) => metersToFeet(a.altitude) >= MIN_ALTITUDE_FT,
  );
  const flights = [];

  for (const plane of overhead) {
    if (!plane.callsign) continue;

    const info = await fetchFlightInfo(plane.callsign);
    const altFt = metersToFeet(plane.altitude);
    const knots = msToKnots(plane.speed);

    if (info) {
      flights.push({
        callsign: info.flightIcao ?? plane.callsign,
        airline: info.airline,
        dep: info.depIata,
        arr: info.arrIata,
        depTime: info.depTime,
        arrTime: info.arrTime,
        alt: altFt,
        speed: knots,
        heading: Math.round(plane.heading),
        status: info.status,
      });
    } else {
      flights.push({
        callsign: plane.callsign,
        alt: altFt,
        speed: knots,
        heading: Math.round(plane.heading),
      });
    }
  }

  overheadFlights[deviceId] = flights;
  console.log(`[${deviceId}] ${flights.length} flights overhead`);
}

// ---------------------------------------------------------
// Routes
// ---------------------------------------------------------
app.get("/hello", (req, res) => {
  res.send("Hello World!");
});

// get bounding box based on photon location
// associate bounding box based on api key given to photon
// that way multiple photons can use this same webserver
app.post("/bounding-box", (req, res) => {
  const { lat, lon } = req.body;
  deviceLocations[req.deviceId] = { lat, lon, updatedAt: Date.now() };
  startPolling(req.deviceId);
  res.json({ ok: true });
});

// test route to check if bounding box saved correctly
app.get("/bounds", (req, res) => {
  res.json(deviceLocations[req.deviceId]);
});

// return json array of flights overhead to be displayed on photon's screen
const overheadFlights = {}; // { deviceId: [flights] }
app.get("/flights", (req, res) => {
  const flights = overheadFlights[req.deviceId] ?? [];
  res.json({ flights });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
