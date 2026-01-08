const express = require("express");
const axios = require("axios");
const cors = require("cors");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
app.use(cors());

app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 5000;

app.get("/health", function (req, res) {
  res.json({ status: "OK", message: "Backend running" });
});

async function getZohoAccessToken() {
  const response = await axios.post(
    "https://accounts.zoho.in/oauth/v2/token",
    null,
    {
      params: {
        refresh_token: process.env.ZOHO_REFRESH_TOKEN,
        client_id: process.env.ZOHO_CLIENT_ID,
        client_secret: process.env.ZOHO_CLIENT_SECRET,
        grant_type: "refresh_token",
      },
    }
  );

  return response.data.access_token;
}


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

app.get("/vendors/search", async (req, res) => {
  try {
    const search = (req.query.q || "").toLowerCase().trim();
    if (search.length < 2) {
      return res.json({ success: true, vendors: [] });
    }

    const accessToken = await getZohoAccessToken();

    let page = 1;
    let matchedVendors = [];
    let hasMore = true;

    while (hasMore && matchedVendors.length === 0) {
      const response = await axios.get(
        "https://zohoapis.in/crm/v2/Vendors",
        {
          headers: {
            Authorization: `Zoho-oauthtoken ${accessToken}`,
          },
          params: {
            page,
            per_page: 200,
          },
        }
      );

      const vendors = response.data.data || [];

      matchedVendors = vendors.filter(v =>
        v.Vendor_Name &&
        v.Vendor_Name.toLowerCase().includes(search)
      );

      hasMore = response.data.info?.more_records === true;
      page++;
    }

    res.json({
      success: true,
      vendors: matchedVendors.slice(0, 20),
    });

  } catch (error) {
    console.error("Vendor Search Error:", error.message);
    res.json({ success: true, vendors: [] });
  }
});

app.get("/oauth/callback", async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).send("Authorization code missing");
  }

  console.log('code === ', code)

  try {
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      redirect_uri: process.env.ZOHO_REDIRECT_URI,
      code: code
    });

    const tokenResponse = await axios.post(
      "https://accounts.zoho.in/oauth/v2/token",
      params.toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        }
      }
    );

    const tokens = tokenResponse.data;

    console.log("✅ Zoho Tokens:", tokens);

    res.json({
      success: true,
      tokens
    });

  } catch (error) {
    console.error("❌ Token Error:", error.response?.data || error.message);

    res.status(500).json({
      success: false,
      error: error.response?.data || error.message
    });
  }
});

app.listen(PORT, function () {
  console.log("🚀 Server running on port " + PORT);
});