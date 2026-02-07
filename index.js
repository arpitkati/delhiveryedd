import express from "express";
import fetch from "node-fetch";

const app = express();

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

const ORIGIN_PIN = process.env.ORIGIN_PIN;                 // your pickup pin (6 digits)
const MOT = process.env.MOT || "E";                        // E or S
const DELHIVERY_TOKEN = process.env.DELHIVERY_TOKEN;

// Choose ONE IP provider (ipinfo recommended if you have token)
const IPINFO_TOKEN = process.env.IPINFO_TOKEN;             // optional, for ipinfo.io
// If you don't want a token, ipapi.co also works (rate limits apply)

function formatDate(d) {
  return d.toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short" });
}

function isValidPin(pin) {
  return /^\d{6}$/.test(String(pin || "").trim());
}

/**
 * Get real client IP behind proxies (Render, Shopify app proxy, Cloudflare, etc.)
 */
function getClientIp(req) {
  const cf = req.headers["cf-connecting-ip"];
  if (cf) return String(cf).trim();

  const xff = req.headers["x-forwarded-for"];
  if (xff) {
    // x-forwarded-for can be "client, proxy1, proxy2"
    return String(xff).split(",")[0].trim();
  }

  // Express populates req.ip but can show proxy IP unless trust proxy enabled
  return (req.ip || req.socket?.remoteAddress || "").toString().trim();
}

/**
 * Normalize IPv6-wrapped IPv4 like "::ffff:1.2.3.4"
 */
function normalizeIp(ip) {
  if (!ip) return "";
  const s = String(ip).trim();
  if (s.startsWith("::ffff:")) return s.replace("::ffff:", "");
  return s;
}

/**
 * Basic private/local IP check (so we don't call geo API for 127.0.0.1 etc.)
 */
function isPrivateIp(ip) {
  if (!ip) return true;
  const s = ip.trim();

  if (s === "127.0.0.1" || s === "::1") return true;
  if (s.startsWith("10.")) return true;
  if (s.startsWith("192.168.")) return true;

  // 172.16.0.0 – 172.31.255.255
  if (s.startsWith("172.")) {
    const parts = s.split(".");
    const second = Number(parts[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

/**
 * IP -> PINCODE using an IP geolocation provider.
 * Prefer ipinfo.io (better quality) if IPINFO_TOKEN exists.
 * Fallback to ipapi.co if no token.
 */
async function ipToPincode(ip) {
  // Try ipinfo.io first (needs token)
  if (IPINFO_TOKEN) {
    const url = `https://ipinfo.io/${encodeURIComponent(ip)}/json?token=${encodeURIComponent(IPINFO_TOKEN)}`;
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    const data = await r.json();
    const pin = data?.postal;
    if (isValidPin(pin)) return String(pin).trim();
  }

  // Fallback: ipapi.co (no token required, but rate limits)
  {
    const url = `https://ipapi.co/${encodeURIComponent(ip)}/json/`;
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    const data = await r.json();
    const pin = data?.postal;
    if (isValidPin(pin)) return String(pin).trim();
  }

  return null;
}

/**
 * Call Delhivery expected TAT using origin + destination pin
 */
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

  // Adjust based on real response if needed
  const tat = data?.tat || data?.data?.tat || data?.response?.tat;

  const tatNum = Number(tat);
  if (!tat || Number.isNaN(tatNum)) return { tat_days: null, raw: data };

  return { tat_days: tatNum, raw: data };
}

// IMPORTANT: helps Express calculate req.ip correctly behind proxies
app.set("trust proxy", true);

// Shopify App Proxy will hit: https://your-render-app.onrender.com/edd
// Optional override: /edd?pin=110001
app.get("/edd", async (req, res) => {
  try {
    // 1) If pin is provided explicitly, use it (useful fallback)
    let destinationPin = (req.query.pin || "").toString().trim();
    let resolvedFrom = "query";

    // 2) Otherwise detect from IP
    if (!isValidPin(destinationPin)) {
      const rawIp = getClientIp(req);
      const ip = normalizeIp(rawIp);

      if (!ip || isPrivateIp(ip)) {
        return res.json({
          ok: false,
          message: "Could not detect user location IP for pincode. Please enter pincode.",
          debug: { ip: rawIp },
        });
      }

      const pinFromIp = await ipToPincode(ip);
      if (!pinFromIp) {
        return res.json({
          ok: false,
          message: "Could not resolve pincode from IP. Please enter pincode.",
          debug: { ip },
        });
      }

      destinationPin = pinFromIp;
      resolvedFrom = "ip";
    }

    // 3) Call Delhivery expected TAT
    const { tat_days, raw } = await getDelhiveryTatDays(destinationPin);

    if (!tat_days) {
      return res.json({
        ok: false,
        message: "EDD not available for this pincode",
        pincode: destinationPin,
        resolved_from: resolvedFrom,
        raw,
      });
    }

    // 4) Compute delivery date (optional cutoff: after 3pm pickup tomorrow)
    const pickupDate = new Date();
    if (pickupDate.getHours() >= 15) pickupDate.setDate(pickupDate.getDate() + 1);

    const deliveryDate = new Date(pickupDate);
    deliveryDate.setDate(deliveryDate.getDate() + Number(tat_days));

    return res.json({
      ok: true,
      pincode: destinationPin,
      resolved_from: resolvedFrom,
      tat_days: Number(tat_days),
      edd: deliveryDate.toISOString().slice(0, 10),
      label: `Delivers by ${formatDate(deliveryDate)}`,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: "Server error", error: e?.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("EDD server running on", PORT));
