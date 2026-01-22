const express = require("express");
const axios = require("axios");
const cors = require("cors");
const dotenv = require("dotenv");
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });

dotenv.config();

const app = express();
app.use(cors());

app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 5000;

app.get("/health", function (req, res) {
  res.json({ status: "OK", message: "Backend running" });
});

// async function getZohoAccessToken() {
//   const response = await axios.post(
//     "https://accounts.zoho.in/oauth/v2/token",
//     null,
//     {
//       params: {
//         refresh_token: process.env.ZOHO_REFRESH_TOKEN,
//         client_id: process.env.ZOHO_CLIENT_ID,
//         client_secret: process.env.ZOHO_CLIENT_SECRET,
//         grant_type: "refresh_token",
//       },
//     }
//   );

//   return response.data.access_token;
// }

let zohoAccessToken = null;
let tokenExpiryTime = null;

async function getZohoAccessToken() {
  const now = Date.now();

  // Reuse token if still valid
  if (zohoAccessToken && tokenExpiryTime && now < tokenExpiryTime) {
    return zohoAccessToken;
  }

  console.log("🔄 Refreshing Zoho Access Token...");

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
    },
  );

  zohoAccessToken = response.data.access_token;

  // Zoho access token valid for 1 hour → refresh after 55 minutes
  tokenExpiryTime = now + 55 * 60 * 1000;

  console.log("✅ Zoho Access Token Updated");

  return zohoAccessToken;
}

app.post("/api/claims", upload.single("file"), async (req, res) => {
  try {
    const data = req.body;

    // Auto-generate claim number
    const now = new Date();
    const pad = (n) => n.toString().padStart(2, "0");

    data.claimNumber =
      "CE" +
      pad(now.getDate()) +
      pad(now.getMonth() + 1) +
      now.getFullYear() +
      pad(now.getHours()) +
      pad(now.getMinutes()) +
      pad(now.getSeconds());

    console.log("Generated Claim Number:", data.claimNumber);

    if (!data.supplierName) {
      return res.status(400).json({
        success: false,
        message: "Supplier Name is required",
      });
    }

    // Convert nested JSON strings into actual objects
    try {
      if (typeof data.discountModels === "string") {
        data.discountModels = JSON.parse(data.discountModels);
      }

      if (typeof data.monthlySchemes === "string") {
        data.monthlySchemes = JSON.parse(data.monthlySchemes);
      }

      if (typeof data.additionalFields === "string") {
        data.additionalFields = JSON.parse(data.additionalFields);
      }

      if (typeof data.items === "string") {
        data.items = JSON.parse(data.items);
      }
      if (data.schemeStartDate) {
        data.schemeStartDate = new Date(data.schemeStartDate)
          .toISOString()
          .slice(0, 10);
      }

      if (data.schemeEndDate) {
        data.schemeEndDate = new Date(data.schemeEndDate)
          .toISOString()
          .slice(0, 10);
      }
    } catch (err) {
      console.error("❌ JSON PARSE ERROR:", err.message);
    }

    const webhookUrls = process.env.WEBHOOK_URLS
      ? process.env.WEBHOOK_URLS.split(",").map((u) => u.trim())
      : [];

    if (webhookUrls.length === 0) {
      return res.status(500).json({
        success: false,
        message: "No webhook URLs configured",
      });
    }

    const requests = webhookUrls.map((url) => {
      return axios.post(url, data, {
        headers: { "Content-Type": "application/json" },
        timeout: 15000,
        validateStatus: (status) => status >= 200 && status < 500,
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
        } else {
          console.error("Error:", result.reason?.message);
        }
      }
    });

    return res.status(200).json({
      success: true,
      message: "Claim processed",
      webhookSuccess: successCount,
      webhookFailed: failureCount,
    });
  } catch (error) {
    console.error("🔥 Backend Error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
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
      const response = await axios.get("https://zohoapis.in/crm/v2/Vendors", {
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
        },
        params: {
          page,
          per_page: 200,
        },
      });

      const vendors = response.data.data || [];

      matchedVendors = vendors.filter(
        (v) => v.Vendor_Name && v.Vendor_Name.toLowerCase().includes(search),
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

// Search Contacts by Mobile Number (partial match)
app.get("/api/contacts/search", async (req, res) => {
  try {
    const mobile = (req.query.mobile || "").trim();

    // Validate input
    if (mobile.length < 4) {
      return res.json({
        success: true,
        suggestions: [],
      });
    }

    const accessToken = await getZohoAccessToken();

    // Search for contacts by mobile number (partial match)
    const response = await axios.get(
      "https://www.zohoapis.in/crm/v2/Contacts/search",
      {
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
          "Content-Type": "application/json",
        },
        params: {
          criteria: `(Mobile:starts_with:${mobile})`,
          per_page: 10,
        },
      },
    );

    // If contacts found
    if (response.data.data && response.data.data.length > 0) {
      const suggestions = response.data.data.map((contact) => ({
        id: contact.id,
        mobile: contact.Mobile,
        firstName: contact.First_Name,
        lastName: contact.Last_Name,
        fullName: contact.Full_Name,
        email: contact.Email,
        alternateNumber: contact.Alternate_Number,
        address: contact.Mailing_Street || "",
        location: contact.Location || "DB",
        gstNumber: contact.GSTIN_Number || "",
        stage1Id: contact.STAGE1_ID || "",
        displayText: `${contact.Mobile} - ${contact.First_Name || ""} ${contact.Last_Name || ""}`,
      }));

      return res.json({
        success: true,
        suggestions,
      });
    }

    // No contacts found
    return res.json({
      success: true,
      suggestions: [],
    });
  } catch (error) {
    // Zoho returns 204 when no data found
    if (error.response?.status === 204) {
      return res.json({
        success: true,
        suggestions: [],
      });
    }

    console.error(
      "Zoho Contact Search Error:",
      error.response?.data || error.message,
    );
    return res.status(500).json({
      success: false,
      message: "Error searching contacts",
      suggestions: [],
    });
  }
});

// Get Contact by ID
app.get("/api/contacts/:id", async (req, res) => {
  try {
    const contactId = req.params.id;

    if (!contactId) {
      return res.status(400).json({
        success: false,
        message: "Contact ID is required",
      });
    }

    const token = await getZohoAccessToken();

    const response = await axios.get(
      `https://www.zohoapis.in/crm/v2/Contacts/${contactId}`,
      {
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          "Content-Type": "application/json",
        },
      },
    );

    if (response.data.data && response.data.data.length > 0) {
      const contact = response.data.data[0];
      const contactData = {
        id: contact.id,
        mobile: contact.Mobile,
        firstName: contact.First_Name,
        lastName: contact.Last_Name,
        fullName: contact.Full_Name,
        email: contact.Email,
        alternateNumber: contact.Alternate_Number,
        address: contact.Mailing_Street || "",
        location: contact.Location || "DB",
        gstNumber: contact.GSTIN_Number || "",
        stage1Id: contact.STAGE1_ID || "",
      };

      return res.json({
        success: true,
        contact: contactData,
      });
    }

    return res.status(404).json({
      success: false,
      message: "Contact not found",
    });
  } catch (error) {
    console.error("Get Contact Error:", error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      message: "Error fetching contact",
    });
  }
});

app.get("/oauth/callback", async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).send("Authorization code missing");
  }

  try {
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      redirect_uri: process.env.ZOHO_REDIRECT_URI,
      code: code,
    });

    const tokenResponse = await axios.post(
      "https://accounts.zoho.in/oauth/v2/token",
      params.toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      },
    );

    const tokens = tokenResponse.data;

    console.log("✅ Zoho Tokens:", tokens);

    res.json({
      success: true,
      tokens,
    });
  } catch (error) {
    console.error("❌ Token Error:", error.response?.data || error.message);

    res.status(500).json({
      success: false,
      error: error.response?.data || error.message,
    });
  }
});

app.post("/api/vendors", upload.single("file"), async (req, res) => {
  try {
    const vendorData = JSON.parse(req.body.vendorData || "{}");

    // ➤ Create payload for webhook
    const payload = {
      vendorData,
      processed_at: req.body.processed_at,
      file: req.file
        ? {
            name: req.file.originalname,
            mimetype: req.file.mimetype,
            size: req.file.size,
            base64: req.file.buffer.toString("base64"),
          }
        : null,
    };

    // ➤ Webhook URLs (same pattern as claims)
    const webhookUrls = process.env.VENDOR_WEBHOOK_URLS
      ? process.env.VENDOR_WEBHOOK_URLS.split(",").map((u) => u.trim())
      : [];

    if (webhookUrls.length === 0) {
      return res.status(500).json({
        success: false,
        message: "No vendor webhook URLs configured",
      });
    }

    console.log("🔗 Sending Vendor to Webhooks:", webhookUrls);

    // ➤ Send to all webhook URLs
    const requests = webhookUrls.map((url) =>
      axios.post(url, payload, {
        headers: { "Content-Type": "application/json" },
        timeout: 15000,
        validateStatus: (status) => status >= 200 && status < 500,
      }),
    );

    const results = await Promise.allSettled(requests);

    let successCount = 0;
    let failureCount = 0;

    results.forEach((result, index) => {
      if (result.status === "fulfilled" && result.value.status < 400) {
        successCount++;
        console.log(`✅ Vendor webhook success: ${webhookUrls[index]}`);
      } else {
        failureCount++;
        console.error(`❌ Vendor webhook failed: ${webhookUrls[index]}`);

        if (result.reason?.response) {
          console.error("Status:", result.reason.response.status);
          console.error("Response:", result.reason.response.data);
        } else {
          console.error("Error:", result.reason?.message);
        }
      }
    });

    return res.status(200).json({
      success: true,
      message: "Vendor processed successfully",
      webhookSuccess: successCount,
      webhookFailed: failureCount,
    });
  } catch (error) {
    console.error("🔥 Vendor Backend Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error (Vendor)",
    });
  }
});
// Search Products
app.get("/api/products/search", async (req, res) => {
  try {
    const keyword = (req.query.keyword || "").trim();

    if (!keyword || keyword.length < 2) {
      return res.json({
        success: true,
        products: [],
      });
    }

    const token = await getZohoAccessToken();

    const response = await axios.get(
      "https://www.zohoapis.in/crm/v2/Products/search",
      {
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          "Content-Type": "application/json",
        },
        params: {
          criteria: `(Product_Name:starts_with:${keyword})`,
          per_page: 10,
        },
      },
    );

    if (response.data.data) {
      const products = response.data.data.map((item) => ({
        id: item.id,
        name: item.Product_Name,
        sku: item.SKU || "",
        rate: item.Unit_Price || 0,
        category: item.Product_Category || "",
        brand: item.Brand || "",
      }));

      return res.json({
        success: true,
        products,
      });
    }

    return res.json({
      success: true,
      products: [],
    });
  } catch (error) {
    console.error(
      "Product Search Error:",
      error.response?.data || error.message,
    );
    return res.json({
      success: false,
      products: [],
    });
  }
});

function generateContactToken() {
  const now = new Date();
  const pad = (n) => n.toString().padStart(2, "0");

  return (
    "CE" +
    pad(now.getDate()) +
    pad(now.getMonth() + 1) +
    now.getFullYear().toString().slice(-2) +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds())
  );
}

// CREATE OR UPDATE CONTACT
app.post("/api/contacts/save", async (req, res) => {
  try {
    const {
      contactId,
      mobile,
      firstName,
      lastName,
      email,
      alternateNumber,
      address,
      location,
      gstNumber,
    } = req.body;

    const token = await getZohoAccessToken();

    // payload shared for create & update
    let payload = {
      data: [
        {
          First_Name: firstName,
          Last_Name: lastName,
          Mobile: mobile,
          Email: email,
          Alternate_Number: alternateNumber,
          Mailing_Street: address,
          Location: location,
          GSTIN_Number: gstNumber || null,
          Contact_Number: mobile,
          Billing_First_Name: firstName,
        },
      ],
    };

    // =======================
    // UPDATE CONTACT
    // =======================
    if (contactId) {
      await axios.put(
        `https://www.zohoapis.in/crm/v2/Contacts/${contactId}`,
        payload,
        { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
      );

      return res.json({
        success: true,
        message: "Contact updated",
        data: { id: contactId },
      });
    }

    // =======================
    // CREATE NEW CONTACT
    // =======================

    // Generate Token (STAGE1_ID)
    const tokenNumber = generateContactToken();

    // Add token into payload
    payload.data[0].STAGE1_ID = tokenNumber;

    const result = await axios.post(
      "https://www.zohoapis.in/crm/v2/Contacts",
      payload,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
    );

    const newId = result.data.data[0].details.id;

    return res.json({
      success: true,
      message: "New contact created",
      data: {
        id: newId,
        token: tokenNumber,
      },
    });
  } catch (err) {
    console.error("Contact Save Error:", err.response?.data || err.message);
    res.status(500).json({ success: false, message: "Error saving contact" });
  }
});

// Generate unique Token Number for Cash Slip (Zoho field: Name)
function generateToken() {
  const now = new Date();
  const pad = (n) => n.toString().padStart(2, "0");

  return (
    "CS" +
    now.getFullYear().toString().slice(-2) +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds())
  );
}

const tokenNumber = generateToken();

// CREATE CASH SLIP / SALE ENTRY
app.post("/api/sales/create", async (req, res) => {
  try {
    const {
      contactId,
      products,
      gstInputClaim,
      gstNumber,
      multiProduct,
      salesman1,
      salesman2,
      salesman3,
      deliveryLater,
      deliveryDate,
      underExchange,
      exchangeInfo,
      diwaliSpinWin,
      discount,
      discountAmount,
      discountApprover,
      discountSignature,
      schemeNo,
      giftAmount,
      paymentMode,
      paymentOther,
      bank,
      additionalInfo,
    } = req.body;

    const token = await getZohoAccessToken();

    // PRODUCT FIELDS MUST BE TEXT IN ZOHO
    const skuFields = {};
    const modelFields = {};
    const rateFields = {};
    const serialFields = {};

    products.forEach((p, i) => {
      const idx = i + 1;

      skuFields[`SKU${idx}`] = String(p.sku || "");
      modelFields[`Model_${idx}`] = String(p.modelNo || "");
      rateFields[`Rate_${idx}`] = String(p.rate || "0");
      serialFields[`Serial_No_${idx}`] = String(p.serialNo || "");
    });

    const billAmount = products.reduce(
      (t, p) => t + Number(p.rate) * Number(p.quantity),
      0,
    );

    const payload = {
      data: [
        {
          Name: tokenNumber,
          Contact_Name: contactId,
          Billing_Name: products[0].productName,
          Mobile_Number: products[0].mobile,
          Address: products[0].address,

          ...skuFields,
          ...modelFields,
          ...rateFields,
          ...serialFields,

          Product_Category: products.map((p) => p.category),
          One_Assist: products[0].oneAssist,
          One_Assist_Amount: products[0].oneAssistAmount,

          GST_INPUT_REQUIRED: gstInputClaim,
          GST_Number: gstNumber,
          Discount: discount,
          How_Much: discountAmount,
          Discount_Approved_By: discountApprover,

          Under_Exchange: underExchange,
          Under_Exchange_info: exchangeInfo,

          Diwali_2024_Spin: products[0].spinPercent,
          Scheme_Number: schemeNo,
          Gift_Contribution: giftAmount,

          Delivery_Later: deliveryLater,
          Delivery_On: deliveryDate || null,
          Demo_Installation_Required: products[0].installationRequired,

          Payment_Mode: paymentMode,
          If_other_What: paymentOther,
          Which_Bank_Credit_Card: bank,

          Salesman_1: salesman1,
          Salesman_2: salesman2,

          Additional_Information: additionalInfo,

          Bill_Amount: billAmount,
        },
      ],
    };

    const saleRes = await axios.post(
      "https://www.zohoapis.in/crm/v2/Cash_Slips",
      payload,
      {
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          "Content-Type": "application/json",
        },
      },
    );

    return res.json({
      success: true,
      message: "Cash Slip created successfully",
      data: saleRes.data,
    });
  } catch (err) {
    console.error("Cash Slip Error:", err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      message: "Error creating cash slip",
    });
  }
});

// Add these routes to your existing backend file
// Add these routes to your existing backend

// Search Contacts for Finance Form
app.get("/api/finance/contacts/search", async (req, res) => {
  try {
    const mobile = (req.query.mobile || "").trim();

    if (mobile.length < 4) {
      return res.json({
        success: true,
        suggestions: [],
      });
    }

    const accessToken = await getZohoAccessToken();

    // Search in Contacts module
    const response = await axios.get(
      "https://www.zohoapis.in/crm/v2/Contacts/search",
      {
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
          "Content-Type": "application/json",
        },
        params: {
          criteria: `(Mobile:starts_with:${mobile})`,
          per_page: 10,
        },
      },
    );

    if (response.data.data && response.data.data.length > 0) {
      const suggestions = response.data.data.map((contact) => ({
        id: contact.id,
        Name: contact.First_Name || contact.Name || "",
        Last_Name: contact.Last_Name || "",
        Fathers_Name: contact.Fathers_Name || "",
        Mobile_Number: contact.Mobile || "",
        Contact_Number: contact.Contact_Number || "",
        Email: contact.Email || "",
        Secondary_Email: contact.Secondary_Email || "",
        Address: contact.Mailing_Street || contact.Address || "",
        District: contact.District || "",
        Location: contact.Location || "",
        Office_Name: contact.Office_Name || "",
        Office_Address: contact.Office_Address || "",
        Full_Name:
          contact.Full_Name ||
          `${contact.First_Name || ""} ${contact.Last_Name || ""}`.trim(),
      }));

      return res.json({
        success: true,
        suggestions,
      });
    }

    return res.json({
      success: true,
      suggestions: [],
    });
  } catch (error) {
    if (error.response?.status === 204) {
      return res.json({
        success: true,
        suggestions: [],
      });
    }

    console.error(
      "Contact Search Error:",
      error.response?.data || error.message,
    );
    return res.status(500).json({
      success: false,
      message: "Error searching contacts",
      suggestions: [],
    });
  }
});

// Add these routes to your existing backend
// Search Trail Records by Mobile Number
// Search Trail Records by Mobile Number
// Search Trail Records by Mobile (with partial match)
app.get("/api/trail/search", async (req, res) => {
  try {
    const mobile = (req.query.mobile || "").trim();

    if (mobile.length < 4) {
      return res.json({ success: true, records: [] });
    }

    const zohoToken = await getZohoAccessToken();

    // Using contains for better partial matching (if Zoho supports it for phone fields)
    // If Zoho only supports equals for phone fields, use that
    const criteria = `(Mobile_Number:equals:${mobile})`;

    const response = await axios.get(
      "https://www.zohoapis.in/crm/v2/Trial/search",
      {
        headers: {
          Authorization: `Zoho-oauthtoken ${zohoToken}`,
          "Content-Type": "application/json",
        },
        params: {
          criteria,
          per_page: 10,
        },
      },
    );

    return res.json({
      success: true,
      records: response.data.data || [],
    });
  } catch (error) {
    if (error.response?.status === 204) {
      return res.json({ success: true, records: [] });
    }

    console.error("Trail Search Error:", error.response?.data || error.message);

    return res.status(500).json({
      success: false,
      message: "Error searching Trail records",
      records: [],
    });
  }
});

// Create New Trail Record (with duplicate check)
// Create New Trail Record (ALWAYS creates new record, even if mobile exists)
app.post(
  "/api/trail/create",
  upload.single("Record_Image"),
  async (req, res) => {
    try {
      const mobileNumber = (req.body.Mobile_Number || "").trim();
      const accessToken = await getZohoAccessToken();

      // ===== Duplicate Check =====
      let existingRecords = [];
      if (mobileNumber && mobileNumber.length >= 4) {
        try {
          const criteria = `(Mobile_Number:equals:${mobileNumber})`;
          const existingResponse = await axios.get(
            "https://www.zohoapis.in/crm/v2/Trial/search",
            {
              headers: {
                Authorization: `Zoho-oauthtoken ${accessToken}`,
                "Content-Type": "application/json",
              },
              params: { criteria, per_page: 5 },
            },
          );

          if (existingResponse.data.data?.length > 0) {
            existingRecords = existingResponse.data.data;
            console.log(
              `⚠️ Mobile number ${mobileNumber} exists in ${existingRecords.length} record(s). Creating NEW record.`,
            );
          }
        } catch (error) {
          console.log("Duplicate check failed:", error.message);
        }
      }

      // ===== Owner Field Handling =====
      let ownerValue = null;
      if (req.body.Owner && !isNaN(req.body.Owner)) {
        ownerValue = parseInt(req.body.Owner);
      }

      // Helper functions
      const toYesNo = (value) => {
        if (
          value === true ||
          value === "true" ||
          value === 1 ||
          value === "1" ||
          value === "Yes" ||
          value === "yes" ||
          value === "on"
        ) {
          return "Yes";
        }
        return "No";
      };

      const toBoolean = (value) => {
        if (
          value === true ||
          value === "true" ||
          value === 1 ||
          value === "1" ||
          value === "Yes" ||
          value === "yes" ||
          value === "on"
        ) {
          return true;
        }
        return false;
      };

      const toYesNoNumber = (value) => {
        if (
          value === true ||
          value === "true" ||
          value === 1 ||
          value === "1" ||
          value === "Yes" ||
          value === "yes" ||
          value === "on"
        ) {
          return 1;
        }
        return 0;
      };

      // ===== Ensure Contacts lookup exists =====
      let contactId = null;
      // Create new Contact if not exists
      if (!contactId) {
        const newContact = await axios.post(
          "https://www.zohoapis.in/crm/v2/Contacts",
          {
            data: [
              {
                Last_Name: req.body.Name || "Customer",
                Mobile: req.body.Mobile_Number,
              },
            ],
          },
          {
            headers: {
              Authorization: `Zoho-oauthtoken ${accessToken}`,
            },
          },
        );

        contactId = newContact.data.data[0].details.id;
      }
      const formatDateForZoho = (dateValue) => {
        if (!dateValue) return null;

        try {
          // If it's already in YYYY-MM-DD format
          if (
            typeof dateValue === "string" &&
            /^\d{4}-\d{2}-\d{2}$/.test(dateValue)
          ) {
            return dateValue;
          }

          // Try to parse and format
          const date = new Date(dateValue);
          if (isNaN(date.getTime())) return null;

          return date.toISOString().split("T")[0]; // Returns YYYY-MM-DD
        } catch (error) {
          console.error("Error formatting date:", error);
          return null;
        }
      };

      const createdTime = new Date().toISOString().slice(0, 19);

      // Helper to parse array fields
      const parseArrayField = (value) => {
        if (!value) return [];
        if (Array.isArray(value)) return value;
        try {
          const parsed = JSON.parse(value);
          if (Array.isArray(parsed)) return parsed;
        } catch (e) {
          // If not JSON, treat as comma-separated
          if (typeof value === 'string') {
            return value.split(',').map(v => v.trim()).filter(Boolean);
          }
        }
        return [];
      };

      // ===== Prepare Payload =====
      const payload = {
        data: [
          {
            // Customer Details (Form 26)
            Name: req.body.Name || "",
            Last_Name: req.body.Last_Name || "",
            Fathers_Name: req.body.Fathers_Name || "",
            Mobile_Number: req.body.Mobile_Number || "",
            Contact_Number: req.body.Contact_Number || "",
            Alternate_Number: req.body.Alternate_Number || "",
            Date_Of_Birth: formatDateForZoho(req.body.Date_Of_Birth),
            Email_Address: req.body.Email || "",
            Secondary_Email: req.body.Secondary_Email || "",
            Address: req.body.Address || "",
            Address_Type: req.body.Address_Type || "",
            District: req.body.District || "",
            Location: req.body.Location || "",
            Office_Name: req.body.Office_Name || "",
            Office_Address: req.body.Office_Address || "",
            Salesman_Name: req.body.Salesman_Name || "",
            Salesman_Name_2: req.body.Salesman_Name_2 || "",
            Contacts: contactId ? { id: contactId } : null,
            CREATED_TIME_AND_DATE: createdTime,

            // Financial Details
            Bill_Amount: parseFloat(req.body.Bill_Amount) || null,
            Approx_Advance: parseFloat(req.body.Approx_Advance) || null,
            Balance: parseFloat(req.body.Balance) || null,
            Bank_Amt: parseFloat(req.body.Bank_Amt) || null,
            Total_Cash_Received:
              parseFloat(req.body.Total_Cash_Received) || null,
            Other_Payment_mode_recd:
              parseFloat(req.body.Other_Payment_mode_recd) || null,
            Cheque_Amt: parseFloat(req.body.Cheque_Amt) || null,

            Down_Payment_1: parseFloat(req.body.Down_Payment_1) || null,
            Down_Payment_2: parseFloat(req.body.Down_Payment_2) || null,
            Down_Payment_3: parseFloat(req.body.Down_Payment_3) || null,
            Down_Payment_4: parseFloat(req.body.Down_Payment_4) || null,
            Down_Payment_5: parseFloat(req.body.Down_Payment_5) || null,

            Mode_Of_Payment: req.body.Mode_Of_Payment || "Cash",
            Finance_By1: req.body.Finance_By1 || "",

            Finance_By: (() => {
              try {
                const arr = JSON.parse(req.body.Finance_By || "[]");
                return Array.isArray(arr)
                  ? arr.join(", ")
                  : req.body.Finance_By;
              } catch {
                return req.body.Finance_By || "";
              }
            })(),

            EMI_Start_Date: formatDateForZoho(req.body.EMI_Start_Date),
            EMI_End_Date: formatDateForZoho(req.body.EMI_End_Date),
            Delivery_On: formatDateForZoho(req.body.Delivery_On),
            Limit: parseFloat(req.body.Limit) || null,
            Limit_Approved: toYesNoNumber(req.body.Limit_Approved),

            // Product Details (Including Form 26 Fields)
            SKU1: req.body.SKU1 || "",
            SKU2: req.body.SKU2 || "",
            SKU3: req.body.SKU3 || "",
            SKU4: req.body.SKU4 || "",
            SKU5: req.body.SKU5 || "",

            Model_No: req.body.Model_No || "",
            Model_No_2: req.body.Model_No_2 || "",
            Model_No_3: req.body.Model_No_3 || "",
            Model_No_4: req.body.Model_No_4 || "",
            Model_No_5: req.body.Model_No_5 || "",

            Serial_No: req.body.Serial_No || "",
            Serial_Number_2: req.body.Serial_Number_2 || "",
            Serial_No_3: req.body.Serial_No_3 || "",
            Serial_No_4: req.body.Serial_No_4 || "",
            Serial_No_5: req.body.Serial_No_5 || "",

            Rate_1: req.body.Rate_1 ? req.body.Rate_1.toString() : "0",
            Rate_2: req.body.Rate_2 ? req.body.Rate_2.toString() : "0",
            Rate_3: req.body.Rate_3 ? req.body.Rate_3.toString() : "0",
            Rate_4: req.body.Rate_4 ? req.body.Rate_4.toString() : "0",
            Rate_5: req.body.Rate_5 ? req.body.Rate_5.toString() : "0",

            Prod_Category: parseArrayField(req.body.Prod_Category),

            // NEW FIELDS FROM FORM NO. 26
            Multi_Product: toBoolean(req.body.Multi_Product),
            Company_Brand: req.body.Company_Brand || "",
            Discount1: toBoolean(req.body.Discount1),
            Under_Exchange: toBoolean(req.body.Under_Exchange),
            Previous_Loan: toBoolean(req.body.Previous_Loan),
            One_Assist: req.body.One_Assist || "",
            One_Assist_Amount: parseFloat(req.body.One_Assist_Amount) || null,
            Diwali_2024_Spin: req.body.Diwali_2024_Spin || "",

            // Delivery Details
            Delivery: req.body.Delivery || "",
            Delivery_On: req.body.Delivery_On || "",
            Delivery_Later: toBoolean(req.body.Delivery_Later),
            Delivered: toBoolean(req.body.Delivered),
            Ok_for_Delivery: toBoolean(req.body.Ok_for_Delivery),
            Location_Of_Delivery: req.body.Location_Of_Delivery || "",

            // Scheme Details
            Scheme_Offered: parseArrayField(req.body.Scheme_Offered),
            Scheme_Number: req.body.Scheme_Number || "",
            
            // Gift Details (Form 26)
            Gift_Name: req.body.Gift_Name || "",
            Gift_Number: req.body.Gift_Number || "",
            Gift_Contribution: req.body.Gift_Contribution || "",
            Gift_Offer: parseArrayField(req.body.Gift_Offer),
            
            Gifts_on_Air: toBoolean(req.body.Gifts_on_Air),
            Spin_Wheel_Gifts: req.body.Spin_Wheel_Gifts || "",

            Rs_1000_Cashback: toBoolean(req.body.Rs_1000_Cashback),
            Rs_2000_Cashback: toBoolean(req.body.Rs_2000_Cashback),
            Redeemed: toBoolean(req.body.Redeemed),
            Redeemed_Cashback: parseFloat(req.body.Redeemed_Cashback) || null,

            // Claims Details
            Claim_No_1: req.body.Claim_No_1 || "",
            Claim_No_2: req.body.Claim_No_2 || "",
            Claim_No_3: req.body.Claim_No_3 || "",
            Claim_No_4: req.body.Claim_No_4 || "",
            Claim_No_5: req.body.Claim_No_5 || "",

            Delivered_Company_Scheme: toBoolean(
              req.body.Delivered_Company_Scheme,
            ),
            Delivered_DDS: toBoolean(req.body.Delivered_DDS),

            // Metadata
            Toeken_number: req.body.Toeken_number || "",
            Trial_ID: req.body.Trial_ID || "",
            // Lookup fields should be in format: { "id": "1234567890" }
            INVOICE_NUMBER: req.body.INVOICE_NUMBER
              ? { id: req.body.INVOICE_NUMBER }
              : null,
            Sales_Order_Number: req.body.Sales_Order_Number
              ? { id: req.body.Sales_Order_Number }
              : null,
            Stage: req.body.Stage || "New",

            ...(ownerValue !== null && { Owner: ownerValue }),
          },
        ],
      };

      console.log("Payload to be sent:", JSON.stringify(payload, null, 2));

      // ===== Create Record =====
      const response = await axios.post(
        "https://www.zohoapis.in/crm/v2/Trial",
        payload,
        {
          headers: {
            Authorization: `Zoho-oauthtoken ${accessToken}`,
            "Content-Type": "application/json",
          },
        },
      );

      const recordId = response.data.data[0].details.id;

      // Upload Image
      if (req.file) {
        await uploadTrailImage(req.file, recordId, accessToken);
      }

      res.json({
        success: true,
        message: "NEW Trail record created successfully",
        data: response.data,
        recordId,
        note:
          existingRecords.length > 0
            ? `Note: Mobile number ${mobileNumber} exists in ${existingRecords.length} record(s). New record created with token: ${req.body.Toeken_number}`
            : `Note: New mobile number. Record created with token: ${req.body.Toeken_number}`,
      });
    } catch (err) {
      console.error("Trail Create Error:", err.response?.data || err.message);

      // Log full error details
      if (err.response?.data) {
        console.error(
          "Zoho API Error Details:",
          JSON.stringify(err.response.data, null, 2),
        );
      }

      // Specific Field Error
      if (err.response?.data?.data?.[0]?.code === "INVALID_DATA") {
        const fieldName = err.response.data.data[0].details.api_name;
        const expectedType =
          err.response.data.data[0].details.expected_data_type;

        return res.status(400).json({
          success: false,
          message: `Invalid data format for field "${fieldName}". Expected: ${expectedType}.`,
          error: err.response.data,
        });
      }

      res.status(500).json({
        success: false,
        message: "Error creating Trail record",
        error: err.response?.data || err.message,
      });
    }
  },
);

// Separate endpoint if you want to check duplicates before creation
app.post("/api/trail/check-duplicate", async (req, res) => {
  try {
    const mobileNumber = (req.body.Mobile_Number || "").trim();

    if (!mobileNumber || mobileNumber.length < 4) {
      return res.json({
        success: true,
        isDuplicate: false,
        message: "Mobile number is too short for duplicate check",
      });
    }

    const accessToken = await getZohoAccessToken();

    const criteria = `(Mobile_Number:equals:${mobileNumber})`;
    const existingResponse = await axios.get(
      "https://www.zohoapis.in/crm/v2/Trial/search",
      {
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
          "Content-Type": "application/json",
        },
        params: {
          criteria,
          per_page: 5,
        },
      },
    );

    const isDuplicate =
      existingResponse.data.data && existingResponse.data.data.length > 0;

    return res.json({
      success: true,
      isDuplicate: isDuplicate,
      existingRecords: existingResponse.data.data || [],
      count: existingResponse.data.data ? existingResponse.data.data.length : 0,
      message: isDuplicate
        ? `Found ${existingResponse.data.data.length} existing record(s) with this mobile number`
        : "No duplicate records found",
    });
  } catch (error) {
    console.error(
      "Duplicate Check Error:",
      error.response?.data || error.message,
    );
    return res.status(500).json({
      success: false,
      message: "Error checking for duplicates",
      error: error.response?.data || error.message,
    });
  }
});

app.listen(PORT, function () {
  console.log("🚀 Server running on port " + PORT);
});
