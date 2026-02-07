import express from "express";
import fetch from "node-fetch";

const app = express();

/* -----------------------------
   Basic CORS
----------------------------- */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

/* -----------------------------
   ENV Variables
----------------------------- */
const ORIGIN_PIN = process.env.ORIGIN_PIN; // Pickup pincode
const MOT = process.env.MOT || "E"; // E or S
const DELHIVERY_TOKEN = process.env.DELHIVERY_TOKEN;

const IPINFO_TOKEN = process.env.IPINFO_TOKEN; // Recommended

/* -----------------------------
   IMPORTANT for Proxies
----------------------------- */
app.set("trust proxy", true);

/* -----------------------------
   Helpers
----------------------------- */
function formatDate(d) {
  return d.toLocaleDateString("en-IN", {
    weekday: "short",
    day: "2-digit",
    month: "short",
  });
}

function isValidPin(pin) {
  return /^\d{6}$/.test(String(pin || "").trim());
}

/* -----------------------------
   ✅ Correct Client IP Detection
   Priority:
   1) x-real-ip
   2) x-forwarded-for (first IP)
   3) cf-connecting-ip
   4) Express fallback
----------------------------- */
function getClientIp(req) {
  const realIp = req.headers["x-real-ip"];
  if (realIp) return String(realIp).trim();

  const xff = req.headers["x-forwarded-for"];
  if (xff) {
    return String(xff).split(",")[0].trim();
  }

  const cf = req.headers["cf-connecting-ip"];
  if (cf) return String(cf).trim();

  return (req.ip || req.socket?.remoteAddress || "").toString().trim();
}

/* Normalize IPv6-wrapped IPv4 */
function normalizeIp(ip) {
  if (!ip) return "";
  let s = String(ip).trim();

  if (s.startsWith("::ffff:")) s = s.replace("::ffff:", "");
  if (s.includes("%")) s = s.split("%")[0];

  return s;
}

/* Private/local IP check */
function isPrivateIp(ip) {
  if (!ip) return true;
  const s = ip.trim();

  if (s === "127.0.0.1" || s === "::1") return true;
  if (s.startsWith("10.")) return true;
  if (s.startsWith("192.168.")) return true;

  if (s.startsWith("172.")) {
    const parts = s.split(".");
    const second = Number(parts[1]);
    if (second >= 16 && second <= 31) return true;
  }

  return false;
}

/* -----------------------------
   Safe Fetch JSON (prevents crashes)
----------------------------- */
async function safeFetchJson(url, options = {}) {
  const r = await fetch(url, options);
  const text = await r.text();

  try {
    return { ok: r.ok, json: JSON.parse(text) };
  } catch {
    return { ok: false, json: null };
  }
}

/* -----------------------------
   IP → PINCODE Lookup
----------------------------- */
async function ipToPincode(ip) {
  // Best: ipinfo.io (token required)
  if (IPINFO_TOKEN) {
    const url = `https://ipinfo.io/${encodeURIComponent(
      ip
    )}/json?token=${encodeURIComponent(IPINFO_TOKEN)}`;

    const { ok, json } = await safeFetchJson(url, {
      headers: { Accept: "application/json" },
    });

    if (ok) {
      const pin = json?.postal;
      if (isValidPin(pin)) return String(pin).trim();
    }
  }

  // Fallback: ipapi.co
  const url = `https://ipapi.co/${encodeURIComponent(ip)}/json/`;

  const { ok, json } = await safeFetchJson(url, {
    headers: { Accept: "application/json" },
  });

  if (ok) {
    const pin = json?.postal;
    if (isValidPin(pin)) return String(pin).trim();
  }

  return null;
}

/* -----------------------------
   Delhivery Expected TAT
----------------------------- */
async function getDelhiveryTatDays(destinationPin) {
  const url = new URL("https://track.delhivery.com/api/dc/expected_tat");

  url.searchParams.set("origin_pin", ORIGIN_PIN);
  url.searchParams.set("destination_pin", destinationPin);
  url.searchParams.set("mot", MOT);

  const { ok, json } = await safeFetchJson(url.toString(), {
    headers: {
      Accept: "application/json",
      Authorization: `Token ${DELHIVERY_TOKEN}`,
    },
  });

  if (!ok || !json) return null;

  const tat = json?.tat || json?.data?.tat || json?.response?.tat;
  const tatNum = Number(tat);

  if (!tat || Number.isNaN(tatNum)) return null;

  return tatNum;
}

/* -----------------------------
   Always Safe Fallback Response
----------------------------- */
function fail(res) {
  return res.json({
    ok: false,
    message: "Please enter pincode.",
  });
}

/* -----------------------------
   MAIN ENDPOINT: /edd
----------------------------- */
app.get("/edd", async (req, res) => {
  try {
    /* Manual pin override */
    let destinationPin = (req.query.pin || "").toString().trim();
    let resolvedFrom = "query";

    /* Auto detect pin from IP */
    if (!isValidPin(destinationPin)) {
      const rawIp = getClientIp(req);
      const ip = normalizeIp(rawIp);

      if (!ip || isPrivateIp(ip)) return fail(res);

      const pinFromIp = await ipToPincode(ip);
      if (!pinFromIp) return fail(res);

      destinationPin = pinFromIp;
      resolvedFrom = "ip";
    }

    /* Delhivery TAT */
    const tatDays = await getDelhiveryTatDays(destinationPin);
    if (!tatDays) return fail(res);

    /* Delivery Date Calculation */
    const pickupDate = new Date();

    // Cutoff: after 3 PM pickup next day
    if (pickupDate.getHours() >= 15) {
      pickupDate.setDate(pickupDate.getDate() + 1);
    }

    const deliveryDate = new Date(pickupDate);
    deliveryDate.setDate(deliveryDate.getDate() + tatDays);

    return res.json({
      ok: true,
      pincode: destinationPin,
      resolved_from: resolvedFrom,
      tat_days: tatDays,
      edd: deliveryDate.toISOString().slice(0, 10),
      label: `Delivers by ${formatDate(deliveryDate)}`,
    });
  } catch (e) {
    console.error("EDD Error:", e);
    return fail(res);
  }
});

/* -----------------------------
   OPTIONAL DEBUG ROUTE
   Test: /ipdebug
----------------------------- */
app.get("/ipdebug", (req, res) => {
  return res.json({
    x_real_ip: req.headers["x-real-ip"],
    x_forwarded_for: req.headers["x-forwarded-for"],
    cf_connecting_ip: req.headers["cf-connecting-ip"],
    detected_ip: getClientIp(req),
    req_ip: req.ip,
  });
});

/* -----------------------------
   Start Server
----------------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("EDD server running on", PORT));
