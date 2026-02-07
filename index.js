import express from "express";
import fetch from "node-fetch";

const app = express();

/* -----------------------------
   Basic CORS (safe)
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
const ORIGIN_PIN = process.env.ORIGIN_PIN; // pickup pin
const MOT = process.env.MOT || "E"; // E or S
const DELHIVERY_TOKEN = process.env.DELHIVERY_TOKEN;

const IPINFO_TOKEN = process.env.IPINFO_TOKEN; // recommended

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
   ✅ Correct Client IP for Shopify App Proxy
----------------------------- */
function getClientIp(req) {
  // ✅ Shopify App Proxy real client IP
  const shopifyIp = req.headers["x-shopify-client-ip"];
  if (shopifyIp) return String(shopifyIp).trim();

  // Cloudflare (if present)
  const cf = req.headers["cf-connecting-ip"];
  if (cf) return String(cf).trim();

  // Standard forwarded chain
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();

  // Fallback
  return (req.ip || req.socket?.remoteAddress || "").toString().trim();
}

/* Normalize IPv6-wrapped IPv4 */
function normalizeIp(ip) {
  if (!ip) return "";
  let s = String(ip).trim();

  if (s.startsWith("::ffff:")) s = s.replace("::ffff:", "");
  if (s.includes("%")) s = s.split("%")[0]; // remove zone index

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
   IP → PINCODE Lookup
----------------------------- */
async function ipToPincode(ip) {
  // ✅ Best: ipinfo.io (needs token)
  if (IPINFO_TOKEN) {
    const url = `https://ipinfo.io/${encodeURIComponent(
      ip
    )}/json?token=${encodeURIComponent(IPINFO_TOKEN)}`;

    const r = await fetch(url, { headers: { Accept: "application/json" } });
    const data = await r.json();

    const pin = data?.postal;
    if (isValidPin(pin)) return String(pin).trim();
  }

  // Fallback: ipapi.co (rate limited)
  const url = `https://ipapi.co/${encodeURIComponent(ip)}/json/`;
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  const data = await r.json();

  const pin = data?.postal;
  if (isValidPin(pin)) return String(pin).trim();

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

  const r = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      Authorization: `Token ${DELHIVERY_TOKEN}`,
    },
  });

  const data = await r.json();

  const tat = data?.tat || data?.data?.tat || data?.response?.tat;
  const tatNum = Number(tat);

  if (!tat || Number.isNaN(tatNum)) {
    return { tat_days: null };
  }

  return { tat_days: tatNum };
}

/* -----------------------------
   IMPORTANT for Proxy Headers
----------------------------- */
app.set("trust proxy", true);

/* -----------------------------
   Main Endpoint: /edd
----------------------------- */
app.get("/edd", async (req, res) => {
  try {
    /* 1. Manual PIN override */
    let destinationPin = (req.query.pin || "").toString().trim();
    let resolvedFrom = "query";

    /* 2. Auto-detect from IP */
    if (!isValidPin(destinationPin)) {
      const rawIp = getClientIp(req);
      const ip = normalizeIp(rawIp);

      if (!ip || isPrivateIp(ip)) {
        return res.json({
          ok: false,
          message: "Please enter pincode.",
        });
      }

      const pinFromIp = await ipToPincode(ip);

      if (!pinFromIp) {
        return res.json({
          ok: false,
          message: "Please enter pincode.",
        });
      }

      destinationPin = pinFromIp;
      resolvedFrom = "ip";
    }

    /* 3. Delhivery TAT */
    const { tat_days } = await getDelhiveryTatDays(destinationPin);

    if (!tat_days) {
      return res.json({
        ok: false,
        message: "Please enter pincode.",
      });
    }

    /* 4. Compute Delivery Date */
    const pickupDate = new Date();

    // Cutoff: after 3pm pickup next day
    if (pickupDate.getHours() >= 15) {
      pickupDate.setDate(pickupDate.getDate() + 1);
    }

    const deliveryDate = new Date(pickupDate);
    deliveryDate.setDate(deliveryDate.getDate() + tat_days);

    return res.json({
      ok: true,
      pincode: destinationPin,
      resolved_from: resolvedFrom,
      tat_days,
      edd: deliveryDate.toISOString().slice(0, 10),
      label: `Delivers by ${formatDate(deliveryDate)}`,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: "Please enter pincode.",
    });
  }
});

/* -----------------------------
   Start Server
----------------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("EDD server running on", PORT));
