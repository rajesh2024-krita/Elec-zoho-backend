const express = require("express");
const axios = require("axios");
const cors = require("cors");
const dotenv = require("dotenv");
const multer = require("multer");
const fs = require("fs");
const FormData = require("form-data");

dotenv.config();

const app = express();
app.use(cors());

// IMPORTANT: do NOT use express.json for file upload routes
app.use(express.urlencoded({ extended: true }));

const upload = multer({ dest: "uploads/" });
const PORT = process.env.PORT || 5000;

/* ----------------------------------
   HEALTH CHECK
---------------------------------- */
app.get("/health", (req, res) => {
  res.json({ status: "OK", message: "Backend running" });
});

/* ----------------------------------
   ZOHO ACCESS TOKEN
---------------------------------- */
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

/* ----------------------------------
   UPLOAD FILE TO WORKDRIVE
---------------------------------- */
async function uploadToWorkDrive(filePath) {
  const accessToken = await getZohoAccessToken();

  const form = new FormData();
  form.append("content", fs.createReadStream(filePath));
  form.append("parent_id", process.env.WORKDRIVE_FOLDER_ID);

  const response = await axios.post(
    "https://www.zohoapis.in/workdrive/api/v1/upload",
    form,
    {
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        ...form.getHeaders(),
      },
    }
  );

  return response.data.data[0];
}

/* ----------------------------------
   CLAIM API (FILE + DATA)
---------------------------------- */
app.post("/api/claims", upload.single("file"), async (req, res) => {
  try {
    const data = req.body;
    const file = req.file;

    console.log('file == ', file)

    if (!data.supplierName) {
      return res.status(400).json({
        success: false,
        message: "Supplier Name is required",
      });
    }

    if (!file) {
      return res.status(400).json({
        success: false,
        message: "File is required",
      });
    }

    console.log("📦 Incoming Data:", data);
    console.log("📎 File Received:", file.originalname);

    // Upload file to WorkDrive
    const workdriveFile = await uploadToWorkDrive(file.path);

    // Attach file info to payload
    data.file_name = file.originalname;
    data.file_url = workdriveFile.attributes.download_url;
    data.workdrive_file_id = workdriveFile.id;

    // Cleanup local temp file
    fs.unlinkSync(file.path);

    // Send to Zoho Flow webhooks
    const webhookUrls = process.env.WEBHOOK_URLS
      ? process.env.WEBHOOK_URLS.split(",").map(u => u.trim())
      : [];

    if (webhookUrls.length === 0) {
      return res.status(500).json({
        success: false,
        message: "No webhook URLs configured",
      });
    }

    const requests = webhookUrls.map(url =>
      axios.post(url, data, {
        headers: { "Content-Type": "application/json" },
        timeout: 15000,
        validateStatus: status => status >= 200 && status < 500,
      })
    );

    const results = await Promise.allSettled(requests);

    let successCount = 0;
    let failureCount = 0;

    results.forEach((r, i) => {
      if (r.status === "fulfilled" && r.value.status < 400) {
        successCount++;
        console.log(`✅ Webhook success: ${webhookUrls[i]}`);
      } else {
        failureCount++;
        console.error(`❌ Webhook failed: ${webhookUrls[i]}`);
      }
    });

    res.json({
      success: true,
      message: "Claim processed",
      webhookSuccess: successCount,
      webhookFailed: failureCount,
    });

  } catch (error) {
    console.error("🔥 Backend Error:", error.response?.data || error.message);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

/* ----------------------------------
   ZOHO CRM VENDOR SEARCH
---------------------------------- */
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

/* ----------------------------------
   START SERVER
---------------------------------- */
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
