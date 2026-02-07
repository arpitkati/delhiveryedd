import express from "express";
import fetch from "node-fetch";

const app = express();

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

const ORIGIN_PIN = process.env.ORIGIN_PIN;
const MOT = process.env.MOT || "E";
const DELHIVERY_TOKEN = process.env.DELHIVERY_TOKEN;

const IPINFO_TOKEN = process.env.IPINFO_TOKEN; // strongly recommended

app.set("trust proxy", true);

function formatDate(d) {
  return d.toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short" });
}

function isValidPin(pin) {
  return /^\d{6}$/.test(String(pin || "").trim());
}

/** ✅ Best-effort client IP */
function getClientIp(req) {
  const shopifyIp = req.headers["x-shopify-client-ip"];
  if (shopifyIp) return String(shopifyIp).trim();

  const cf = req.headers["cf-connecting-ip"];
  if (cf) return String(cf).trim();

  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();

  return (req.ip || req.socket?.remoteAddress || "").toString().trim();
}

function normalizeIp(ip) {
  if (!ip) return "";
  let s = String(ip).trim();
  if (s.startsWith("::ffff:")) s = s.replace("::ffff:", "");
  if (s.includes("%")) s = s.split("%")[0];
  return s;
}

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

/** ✅ Safe fetch JSON (prevents r.json() crash if HTML/text comes back) */
async function safeFetchJson(url, options = {}) {
  const r = await fetch(url, options);
  const text = await r.text();

  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }

  return { ok: r.ok, status: r.status, json, text };
}

async function ipToPincode(ip) {
  // Try ipinfo first if token available
  if (IPINFO_TOKEN) {
    const url = `https://ipinfo.io/${encodeURIComponent(ip)}/json?token=${encodeURIComponent(IPINFO_TOKEN)}`;
    const { ok, json } = await safeFetchJson(url, { headers: { Accept: "application/json" } });
    if (ok) {
      const pin = json?.postal;
      if (isValidPin(pin)) return String(pin).trim();
    }
  }

  // Fallback ipapi
  {
    const url = `https://ipapi.co/${encodeURIComponent(ip)}/json/`;
    const { ok, json } = await safeFetchJson(url, { headers: { Accept: "application/json" } });
    if (ok) {
      const pin = json?.postal;
      if (isValidPin(pin)) return String(pin).trim();
    }
  }

  return null;
}

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

function fail(res) {
  // Always return safe fallback (no 500)
  return res.json({ ok: false, message: "Please enter pincode." });
}

app.get("/edd", async (req, res) => {
  try {
    // Manual pin override
    let destinationPin = (req.query.pin || "").toString().trim();
    let resolvedFrom = "query";

    // Optional: debug mode (remove later)
    const debug = req.query.debug === "1";

    if (!isValidPin(destinationPin)) {
      const ip = normalizeIp(getClientIp(req));

      if (debug) {
        return res.json({
          ok: false,
          message: "debug",
          headers: {
            "x-shopify-client-ip": req.headers["x-shopify-client-ip"],
            "x-forwarded-for": req.headers["x-forwarded-for"],
            "cf-connecting-ip": req.headers["cf-connecting-ip"],
          },
          ip,
          req_ip: req.ip,
        });
      }

      if (!ip || isPrivateIp(ip)) return fail(res);

      const pinFromIp = await ipToPincode(ip);
      if (!pinFromIp) return fail(res);

      destinationPin = pinFromIp;
      resolvedFrom = "ip";
    }

    const tatDays = await getDelhiveryTatDays(destinationPin);
    if (!tatDays) return fail(res);

    const pickupDate = new Date();
    if (pickupDate.getHours() >= 15) pickupDate.setDate(pickupDate.getDate() + 1);

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
    console.error("EDD error:", e);
    return fail(res);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("EDD server running on", PORT));
