const express = require("express");
const axios = require("axios");
const cors = require("cors");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
// app.use(cors());
app.use(cors({
  origin: true,
  credentials: true
}));

app.options("*", cors());

app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 5000;

app.get("/health", function (req, res) {
  res.json({ status: "OK", message: "Backend running" });
});

app.post("/api/claims", async function (req, res) {
  try {
    const data = req.body;

    if (!data.supplierName) {
      return res.status(400).json({
        success: false,
        message: "Supplier Name is required"
      });
    }

    const webhookUrls = process.env.WEBHOOK_URLS
      ? process.env.WEBHOOK_URLS.split(",").map(u => u.trim())
      : [];

    if (webhookUrls.length === 0) {
      return res.status(500).json({
        success: false,
        message: "No webhook URLs configured"
      });
    }

    console.log("📦 Incoming Data:", data);

    const requests = webhookUrls.map(function (url) {
      return axios.post(url, data, {
        headers: {
          "Content-Type": "application/json"
          // Add Authorization if required
          // "Authorization": "Bearer YOUR_TOKEN"
        },
        timeout: 15000,
        validateStatus: function (status) {
          return status >= 200 && status < 500; // IMPORTANT
        }
      });
    });

    const results = await Promise.allSettled(requests);

    let successCount = 0;
    let failureCount = 0;

    results.forEach((result, index) => {
      if (result.status === "fulfilled" && result.value.status < 400) {
        successCount++;
        console.log(`✅ Webhook success: ${webhookUrls[index]}`);
      } else {
        failureCount++;
        console.error(`❌ Webhook failed: ${webhookUrls[index]}`);

        if (result.reason?.response) {
          console.error("Status:", result.reason.response.status);
          console.error("Response:", result.reason.response.data);
        } else if (result.value) {
          console.error("Status:", result.value.status);
          console.error("Response:", result.value.data);
        } else {
          console.error("Error:", result.reason?.message);
        }
      }
    });

    return res.status(200).json({
      success: true,
      message: "Claim processed",
      webhookSuccess: successCount,
      webhookFailed: failureCount
    });

  } catch (error) {
    console.error("🔥 Backend Error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Internal server error"
    });
  }
});

app.listen(PORT, function () {
  console.log("🚀 Server running on port " + PORT);
});
