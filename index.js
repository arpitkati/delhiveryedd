import express from "express";
import fetch from "node-fetch";

const app = express();

const ORIGIN_PIN = process.env.ORIGIN_PIN;         // your pickup pin
const MOT = process.env.MOT || "E";                // E or S
const DELHIVERY_TOKEN = process.env.DELHIVERY_TOKEN;

function formatDate(d) {
  return d.toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short" });
}

// Shopify App Proxy will hit: https://your-render-app.onrender.com/edd?pin=XXXXXX
app.get("/edd", async (req, res) => {
  try {
    const destinationPin = (req.query.pin || "").toString().trim();
    if (!/^\d{6}$/.test(destinationPin)) {
      return res.status(400).json({ ok: false, message: "Invalid pincode" });
    }

    const url = new URL("https://track.delhivery.com/api/dc/expected_tat");
    url.searchParams.set("origin_pin", ORIGIN_PIN);
    url.searchParams.set("destination_pin", destinationPin);
    url.searchParams.set("mot", MOT);

    const r = await fetch(url.toString(), {
      headers: {
        "Accept": "application/json",
        "Authorization": `Token ${DELHIVERY_TOKEN}`
      }
    });

    const data = await r.json();

    // ⚠️ You may need to adjust once you see your actual response keys
    const tat = data?.tat || data?.data?.tat || data?.response?.tat;

    if (!tat || isNaN(Number(tat))) {
      return res.json({ ok: false, message: "EDD not available for this pincode", raw: data });
    }

    const pickupDate = new Date();
    // cutoff logic (optional): after 3pm assume pickup tomorrow
    if (pickupDate.getHours() >= 15) pickupDate.setDate(pickupDate.getDate() + 1);

    const deliveryDate = new Date(pickupDate);
    deliveryDate.setDate(deliveryDate.getDate() + Number(tat));

    return res.json({
      ok: true,
      tat_days: Number(tat),
      edd: deliveryDate.toISOString().slice(0, 10),
      label: `Delivers by ${formatDate(deliveryDate)}`
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: "Server error", error: e?.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("EDD server running on", PORT));
