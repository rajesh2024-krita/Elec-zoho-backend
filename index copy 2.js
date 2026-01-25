const express = require("express");
const axios = require("axios");
const cors = require("cors");
const dotenv = require("dotenv");
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });
const CryptoJS = require("crypto-js");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 5000;

// Token management variables
let zohoAccessToken = null;
let tokenExpiryTime = null;

// ===============================================
// ZOHO ACCESS TOKEN MANAGEMENT
// ===============================================

async function validateZohoToken(token) {
  try {
    const response = await axios.get(
      "https://www.zohoapis.in/crm/v2/Info/Modules",
      {
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          "Content-Type": "application/json",
        },
        timeout: 5000,
      }
    );
    return response.status === 200;
  } catch (error) {
    return false;
  }
}

async function getZohoAccessToken() {
  const now = Date.now();

  // If token exists and not expired, validate it
  if (zohoAccessToken && tokenExpiryTime && now < tokenExpiryTime) {
    const isValid = await validateZohoToken(zohoAccessToken);
    if (isValid) {
      console.log("♻️ Using validated cached token");
      return zohoAccessToken;
    } else {
      console.log("⚠️ Cached token invalid, refreshing...");
      zohoAccessToken = null;
      tokenExpiryTime = null;
    }
  }

  console.log("🔄 Refreshing Zoho Access Token...");

  try {
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
        timeout: 10000,
      }
    );

    if (!response.data.access_token) {
      throw new Error("No access token in response");
    }

    zohoAccessToken = response.data.access_token;
    tokenExpiryTime = now + 55 * 60 * 1000; // 55 minutes

    console.log("✅ Zoho Access Token Updated");
    return zohoAccessToken;
  } catch (error) {
    console.error("❌ Zoho Token Refresh Failed:", error.message);
    
    // Clear invalid tokens
    zohoAccessToken = null;
    tokenExpiryTime = null;
    
    if (error.response) {
      console.error("Status:", error.response.status);
      console.error("Response Data:", error.response.data);
      
      if (error.response.data.error === "invalid_client" || 
          error.response.data.error === "invalid_grant") {
        console.error("⚠️ Check your Zoho credentials (Client ID, Client Secret, Refresh Token)");
      }
    }
    
    throw new Error(`Failed to get Zoho access token: ${error.message}`);
  }
}

// ===============================================
// HELPER FUNCTIONS
// ===============================================

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

function encrypt(text) {
  return CryptoJS.AES.encrypt(text, process.env.AES_SECRET).toString();
}

function decrypt(cipher) {
  const bytes = CryptoJS.AES.decrypt(cipher, process.env.AES_SECRET);
  return bytes.toString(CryptoJS.enc.Utf8);
}

function formatDateForZoho(dateValue) {
  if (!dateValue) return null;
  try {
    if (typeof dateValue === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
      return dateValue;
    }
    const date = new Date(dateValue);
    if (isNaN(date.getTime())) return null;
    return date.toISOString().split("T")[0];
  } catch (error) {
    console.error("Error formatting date:", error);
    return null;
  }
}

function parseArrayField(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
  } catch (e) {
    if (typeof value === "string") {
      return value
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
    }
  }
  return [];
}

function toYesNo(value) {
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
}

function toBoolean(value) {
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
}

function toYesNoNumber(value) {
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
}

// ===============================================
// ROUTES
// ===============================================

app.get("/health", function (req, res) {
  res.json({ status: "OK", message: "Backend running" });
});

// Claims Processing
app.post("/api/claims", upload.single("file"), async (req, res) => {
  try {
    const data = req.body;
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

// Search Vendors
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
        (v) => v.Vendor_Name && v.Vendor_Name.toLowerCase().includes(search)
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

// Search Contacts by Mobile
app.get("/api/contacts/search", async (req, res) => {
  try {
    const mobile = (req.query.mobile || "").trim();
    if (mobile.length < 4) {
      return res.json({
        success: true,
        suggestions: [],
      });
    }

    const accessToken = await getZohoAccessToken();
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
      }
    );

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
      "Zoho Contact Search Error:",
      error.response?.data || error.message
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
      }
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

// OAuth Callback
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
      }
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

// Create/Update Vendor with Purchase Request
app.post("/api/vendors", upload.single("file"), async (req, res) => {
  try {
    const vendorData = JSON.parse(req.body.vendorData || "{}");
    const purchaseRequestData = req.body.purchaseRequestData
      ? JSON.parse(req.body.purchaseRequestData)
      : null;

    const gstin =
      vendorData.GSTIN_NUMBER || vendorData.gstin || vendorData.GSTIN;

    console.log("🔄 Processing Vendor:", vendorData.Vendor_Name);
    console.log(
      "📦 Purchase Request Data:",
      purchaseRequestData ? "Yes" : "No"
    );

    let vendorId = null;
    let vendorAction = "created";
    let purchaseRequestId = null;

    // Get token with error handling
    let token;
    try {
      token = await getZohoAccessToken();
    } catch (tokenError) {
      console.error("❌ Token Error:", tokenError.message);
      return res.status(401).json({
        success: false,
        message: "Failed to authenticate with Zoho",
        error: {
          code: "AUTH_FAILED",
          details: tokenError.message,
          message: "Invalid OAuth token or credentials",
          status: "error"
        }
      });
    }

    // 1️⃣ CHECK IF VENDOR EXISTS
    if (gstin || vendorData.Vendor_Name) {
      try {
        let searchQuery = "";
        if (gstin) {
          searchQuery = `(GSTIN:equals:${gstin})`;
        } else if (vendorData.Vendor_Name) {
          searchQuery = `(Vendor_Name:equals:${encodeURIComponent(vendorData.Vendor_Name)})`;
        }

        if (searchQuery) {
          const searchResponse = await axios.get(
            `${process.env.ZOHO_BASE_URL || 'https://www.zohoapis.in/crm/v2'}/Vendors/search?criteria=${searchQuery}`,
            {
              headers: {
                Authorization: `Zoho-oauthtoken ${token}`,
                "Content-Type": "application/json",
              },
            }
          );

          if (
            searchResponse.data &&
            searchResponse.data.data &&
            searchResponse.data.data.length > 0
          ) {
            vendorId = searchResponse.data.data[0].id;
            vendorAction = "updated";
            console.log(
              `✅ Vendor found: ${vendorId} (${vendorData.Vendor_Name})`
            );
          }
        }
      } catch (error) {
        console.log(`ℹ️ Vendor search failed or no existing vendor found`);
      }
    }

    // 2️⃣ CREATE OR UPDATE VENDOR
    const vendorPayload = {
      data: [
        {
          Vendor_Name: vendorData.Vendor_Name,
          Email: vendorData.Email,
          Phone: vendorData.Phone,
          Website: vendorData.Website,
          Owner_Name: vendorData.Owner_Name,
          Supplier_Code: vendorData.Supplier_Code,
          Vendor_Owner: vendorData.Vendor_Owner,
          Payment_Terms: vendorData.Payment_Terms,
          Currency: vendorData.Currency,
          Source: vendorData.Source,
          GSTIN: gstin,
          GSTIN_NUMBER: gstin,
          Type_of_Supplier: vendorData.Type_of_Supplier,
          Street: vendorData.Street,
          City: vendorData.City,
          State: vendorData.State,
          Zip_Code: vendorData.Zip_Code,
          Country: vendorData.Country,
          Description: vendorData.Description,
          Account_Number: vendorData.accountNumber || vendorData.Account_Number,
          IFSC_Code: vendorData.ifscCode || vendorData.IFSC_Code,
          Bank_Name: vendorData.bankName || vendorData.Bank_Name,
          Branch: vendorData.branch || vendorData.Branch,
          PAN_Number: vendorData.panNumber || vendorData.PAN_Number,
          TAN_Number: vendorData.tanNumber || vendorData.TAN_Number,
          MSME_Registered:
            vendorData.msmeRegistered || vendorData.MSME_Registered,
          MSME_Number: vendorData.msmeNumber || vendorData.MSME_Number,
          Credit_Limit: vendorData.creditLimit || vendorData.Credit_Limit,
          Credit_Period: vendorData.creditPeriod || vendorData.Credit_Period,
          Vendor_Category:
            vendorData.vendorCategory || vendorData.Vendor_Category,
          Bank_Details: vendorData.bankDetails || [],
          Contact_Persons: vendorData.contactPersons || [],
        },
      ],
    };

    try {
      if (vendorId) {
        await axios.put(
          `${process.env.ZOHO_BASE_URL || 'https://www.zohoapis.in/crm/v2'}/Vendors/${vendorId}`,
          vendorPayload,
          {
            headers: {
              Authorization: `Zoho-oauthtoken ${token}`,
              "Content-Type": "application/json",
            },
          }
        );
        console.log(`✅ Vendor updated: ${vendorId}`);
      } else {
        const createResponse = await axios.post(
          `${process.env.ZOHO_BASE_URL || 'https://www.zohoapis.in/crm/v2'}/Vendors`,
          vendorPayload,
          {
            headers: {
              Authorization: `Zoho-oauthtoken ${token}`,
              "Content-Type": "application/json",
            },
          }
        );

        if (
          createResponse.data &&
          createResponse.data.data &&
          createResponse.data.data.length > 0
        ) {
          vendorId = createResponse.data.data[0].details.id;
          console.log(`✅ New vendor created: ${vendorId}`);
        }
      }
    } catch (error) {
      console.error(
        "❌ Vendor operation failed:",
        error.response?.data || error.message
      );
      return res.status(500).json({
        success: false,
        message: "Failed to process vendor",
        error: error.response?.data || error.message,
      });
    }

    // 3️⃣ CREATE PURCHASE REQUEST IF ITEMS PROVIDED
    if (
      vendorId &&
      purchaseRequestData &&
      purchaseRequestData.items &&
      purchaseRequestData.items.length > 0
    ) {
      try {
        const poItems = purchaseRequestData.items.map((item) => ({
          Item_Name: item.name,
          SKU: item.sku || "",
          Quantity: item.quantity || 1,
          Rate: item.rate || 0,
          Tax: item.tax_percentage || 0,
          HSN_SAC: item.hsn_sac || "",
          Books_Item_ID: item.books_item_id || "",
          Item_Description: item.description || "",
          Unit: item.unit || "Nos",
          Total_Amount: (item.quantity || 1) * (item.rate || 0),
          Tax_Amount:
            ((item.quantity || 1) *
              (item.rate || 0) *
              (item.tax_percentage || 0)) /
            100,
          Gross_Amount:
            (item.quantity || 1) * (item.rate || 0) +
            ((item.quantity || 1) *
              (item.rate || 0) *
              (item.tax_percentage || 0)) /
              100,
        }));

        const poNumber = `PO-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        const purchaseRequestPayload = {
          data: [
            {
              Vendor: vendorId,
              Vendor_Name: vendorData.Vendor_Name || "",
              GSTIN: gstin || "",
              Email: vendorData.Email || "",
              Mobile: vendorData.Phone || "",
              Currency: vendorData.Currency || "INR",
              Payment_Terms: vendorData.Payment_Terms || "Default",
              Billing_Address: `${vendorData.Street || ""}, ${vendorData.City || ""}, ${vendorData.State || ""} - ${vendorData.Zip_Code || ""}, ${vendorData.Country || "India"}`,
              Delivery_Address: `${vendorData.Street || ""}, ${vendorData.City || ""}, ${vendorData.State || ""} - ${vendorData.Zip_Code || ""}, ${vendorData.Country || "India"}`,
              Branch: vendorData.branch || "",
              Warehouse: purchaseRequestData.warehouse || "Default",
              Expected_Delivery_Date:
                purchaseRequestData.expected_delivery_date || "",
              Tag: purchaseRequestData.tag || "From Vendor Creation",
              PO_Number: poNumber,
              PO_Items: poItems,
              Exchange_Rate: purchaseRequestData.exchange_rate || 1,
              Sync_Status: "Pending",
              PO_Status: "Draft",
              Total_Amount: poItems.reduce(
                (sum, item) => sum + item.Gross_Amount,
                0
              ),
              Sub_Total: poItems.reduce(
                (sum, item) => sum + item.Total_Amount,
                0
              ),
              Tax_Total: poItems.reduce(
                (sum, item) => sum + item.Tax_Amount,
                0
              ),
              Purchase_Order_Type:
                purchaseRequestData.purchase_order_type || "Standard",
              Requisition_Number: purchaseRequestData.requisition_number || "",
              Project: purchaseRequestData.project || "",
              Department: purchaseRequestData.department || "",
              Approved_By: purchaseRequestData.approved_by || "",
              Terms_and_Conditions:
                purchaseRequestData.terms_and_conditions || "",
              Shipping_Method: purchaseRequestData.shipping_method || "",
              Shipping_Terms: purchaseRequestData.shipping_terms || "",
              Notes: purchaseRequestData.notes || "",
            },
          ],
        };

        const prResponse = await axios.post(
          `${process.env.ZOHO_BASE_URL || 'https://www.zohoapis.in/crm/v2'}/Purchase_Requests`,
          purchaseRequestPayload,
          {
            headers: {
              Authorization: `Zoho-oauthtoken ${token}`,
              "Content-Type": "application/json",
            },
          }
        );

        if (
          prResponse.data &&
          prResponse.data.data &&
          prResponse.data.data.length > 0
        ) {
          purchaseRequestId = prResponse.data.data[0].details.id;
          console.log(
            `✅ Purchase Request created: ${purchaseRequestId} (${poNumber})`
          );
        }
      } catch (error) {
        console.error(
          "❌ Purchase Request creation failed:",
          error.response?.data || error.message
        );
        console.log(
          "⚠️ Vendor created successfully, but purchase request failed"
        );
      }
    }

    // 4️⃣ PREPARE WEBHOOK PAYLOAD
    const payload = {
      vendorData,
      purchaseRequestData: purchaseRequestData || null,
      processed_at: req.body.processed_at,
      vendorId: vendorId,
      vendorAction: vendorAction,
      purchaseRequestId: purchaseRequestId,
      gstin: gstin,
      file: req.file
        ? {
            name: req.file.originalname,
            mimetype: req.file.mimetype,
            size: req.file.size,
            base64: req.file.buffer.toString("base64"),
          }
        : null,
    };

    // 5️⃣ SEND TO WEBHOOKS
    const webhookUrls = process.env.VENDOR_WEBHOOK_URLS
      ? process.env.VENDOR_WEBHOOK_URLS.split(",").map((u) => u.trim())
      : [];

    let webhookResults = { successCount: 0, failureCount: 0, details: [] };

    if (webhookUrls.length > 0) {
      console.log("🔗 Sending to Webhooks:", webhookUrls);
      const requests = webhookUrls.map((url) =>
        axios.post(url, payload, {
          headers: { "Content-Type": "application/json" },
          timeout: 15000,
          validateStatus: (status) => status >= 200 && status < 500,
        })
      );

      const results = await Promise.allSettled(requests);
      results.forEach((result, index) => {
        if (result.status === "fulfilled" && result.value.status < 400) {
          webhookResults.successCount++;
          webhookResults.details.push({
            url: webhookUrls[index],
            status: "success",
            statusCode: result.value.status,
          });
          console.log(`✅ Webhook success: ${webhookUrls[index]}`);
        } else {
          webhookResults.failureCount++;
          webhookResults.details.push({
            url: webhookUrls[index],
            status: "failed",
            error: result.reason?.message || "Unknown error",
          });
          console.error(`❌ Webhook failed: ${webhookUrls[index]}`);
          if (result.reason?.response) {
            console.error("Status:", result.reason.response.status);
            console.error("Response:", result.reason.response.data);
          }
        }
      });
    }

    // 6️⃣ RETURN RESPONSE
    const response = {
      success: true,
      message: `Vendor ${vendorAction} successfully${purchaseRequestId ? " with purchase request" : ""}`,
      data: {
        vendorId: vendorId,
        vendorAction: vendorAction,
        purchaseRequestId: purchaseRequestId,
        vendorName: vendorData.Vendor_Name,
        gstin: gstin,
        timestamp: new Date().toISOString(),
      },
      webhookResults: webhookResults,
    };

    if (purchaseRequestId && purchaseRequestData) {
      response.data.purchaseRequestSummary = {
        itemCount: purchaseRequestData.items?.length || 0,
        totalAmount:
          purchaseRequestData.items?.reduce((sum, item) => {
            const subtotal = (item.quantity || 1) * (item.rate || 0);
            const tax = subtotal * ((item.tax_percentage || 0) / 100);
            return sum + subtotal + tax;
          }, 0) || 0,
        warehouse: purchaseRequestData.warehouse || "Default",
      };
    }

    console.log(
      `✅ Process completed: Vendor ${vendorAction} ${vendorId}, PR: ${purchaseRequestId || "None"}`
    );

    return res.status(200).json(response);
  } catch (error) {
    console.error("🔥 Vendor Backend Error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error (Vendor)",
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// Search Vendor by GSTIN or Name
app.get("/api/vendors/search", async (req, res) => {
  try {
    const { gstin, vendorName } = req.query;
    if (!gstin && !vendorName) {
      return res.status(400).json({
        success: false,
        message: "Either GSTIN or Vendor Name is required",
      });
    }

    let searchCriteria = "";
    if (gstin) {
      searchCriteria = `(GSTIN:equals:${gstin})`;
    } else {
      searchCriteria = `(Vendor_Name:equals:${encodeURIComponent(vendorName)})`;
    }

    const token = await getZohoAccessToken();
    const response = await axios.get(
      `${process.env.ZOHO_BASE_URL || 'https://www.zohoapis.in/crm/v2'}/Vendors/search?criteria=${searchCriteria}`,
      {
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (response.data.data && response.data.data.length > 0) {
      return res.status(200).json({
        success: true,
        exists: true,
        vendor: response.data.data[0],
        count: response.data.data.length,
      });
    } else {
      return res.status(200).json({
        success: true,
        exists: false,
        message: "Vendor not found",
      });
    }
  } catch (error) {
    console.error("Vendor search error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to search vendor",
      error: error.message,
    });
  }
});

// Get Vendor by ID
app.get("/api/vendors/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const token = await getZohoAccessToken();
    const response = await axios.get(
      `${process.env.ZOHO_BASE_URL || 'https://www.zohoapis.in/crm/v2'}/Vendors/${id}`,
      {
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (response.data.data && response.data.data.length > 0) {
      return res.status(200).json({
        success: true,
        vendor: response.data.data[0],
      });
    } else {
      return res.status(404).json({
        success: false,
        message: "Vendor not found",
      });
    }
  } catch (error) {
    console.error("Get vendor error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to get vendor",
      error: error.message,
    });
  }
});

// Update Vendor
app.put("/api/vendors/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const vendorData = req.body;
    const token = await getZohoAccessToken();

    const response = await axios.put(
      `${process.env.ZOHO_BASE_URL || 'https://www.zohoapis.in/crm/v2'}/Vendors/${id}`,
      {
        data: [vendorData],
      },
      {
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    return res.status(200).json({
      success: true,
      message: "Vendor updated successfully",
      data: response.data,
    });
  } catch (error) {
    console.error("Update vendor error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update vendor",
      error: error.message,
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
      }
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
      error.response?.data || error.message
    );
    return res.json({
      success: false,
      products: [],
    });
  }
});

// Create or Update Contact
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

    // UPDATE CONTACT
    if (contactId) {
      await axios.put(
        `https://www.zohoapis.in/crm/v2/Contacts/${contactId}`,
        payload,
        { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
      );

      return res.json({
        success: true,
        message: "Contact updated",
        data: { id: contactId },
      });
    }

    // CREATE NEW CONTACT
    const tokenNumber = generateContactToken();
    payload.data[0].STAGE1_ID = tokenNumber;

    const result = await axios.post(
      "https://www.zohoapis.in/crm/v2/Contacts",
      payload,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
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

// Create Cash Slip / Sale Entry
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
      0
    );

    const payload = {
      data: [
        {
          Name: generateToken(),
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
      }
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
      }
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
      error.response?.data || error.message
    );
    return res.status(500).json({
      success: false,
      message: "Error searching contacts",
      suggestions: [],
    });
  }
});

// Search Trail Records by Mobile
app.get("/api/trail/search", async (req, res) => {
  try {
    const mobile = (req.query.mobile || "").trim();
    if (mobile.length < 4) {
      return res.json({ success: true, records: [] });
    }

    const zohoToken = await getZohoAccessToken();
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
      }
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

// Upload Trail Image Helper
async function uploadTrailImage(file, recordId, accessToken) {
  try {
    const formData = new FormData();
    const blob = new Blob([file.buffer], { type: file.mimetype });
    formData.append("file", blob, file.originalname);

    await axios.post(
      `https://www.zohoapis.in/crm/v2/Trial/${recordId}/attachments`,
      formData,
      {
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
          "Content-Type": "multipart/form-data",
        },
      }
    );

    console.log(`✅ Image uploaded for record: ${recordId}`);
  } catch (error) {
    console.error("❌ Image upload failed:", error.message);
  }
}

// Create New Trail Record
app.post(
  "/api/trail/create",
  upload.single("Record_Image"),
  async (req, res) => {
    try {
      const mobileNumber = (req.body.Mobile_Number || "").trim();
      const accessToken = await getZohoAccessToken();

      // Duplicate Check
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
            }
          );

          if (existingResponse.data.data?.length > 0) {
            existingRecords = existingResponse.data.data;
            console.log(
              `⚠️ Mobile number ${mobileNumber} exists in ${existingRecords.length} record(s). Creating NEW record.`
            );
          }
        } catch (error) {
          console.log("Duplicate check failed:", error.message);
        }
      }

      // Owner Field Handling
      let ownerValue = null;
      if (req.body.Owner && !isNaN(req.body.Owner)) {
        ownerValue = parseInt(req.body.Owner);
      }

      // Create Contact if needed
      let contactId = null;
      if (mobileNumber) {
        try {
          const newContact = await axios.post(
            "https://www.zohoapis.in/crm/v2/Contacts",
            {
              data: [
                {
                  Last_Name: req.body.Name || "Customer",
                  Mobile: mobileNumber,
                },
              ],
            },
            {
              headers: {
                Authorization: `Zoho-oauthtoken ${accessToken}`,
              },
            }
          );
          contactId = newContact.data.data[0].details.id;
        } catch (error) {
          console.log("Contact creation failed:", error.message);
        }
      }

      const createdTime = new Date().toISOString().slice(0, 19);

      // Prepare Payload
      const payload = {
        data: [
          {
            // Customer Details
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

            // Product Details
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

            // New Fields
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

            // Gift Details
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
              req.body.Delivered_Company_Scheme
            ),
            Delivered_DDS: toBoolean(req.body.Delivered_DDS),

            // Metadata
            Toeken_number: req.body.Toeken_number || "",
            Trial_ID: req.body.Trial_ID || "",
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

      // Create Record
      const response = await axios.post(
        "https://www.zohoapis.in/crm/v2/Trial",
        payload,
        {
          headers: {
            Authorization: `Zoho-oauthtoken ${accessToken}`,
            "Content-Type": "application/json",
          },
        }
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

      if (err.response?.data) {
        console.error(
          "Zoho API Error Details:",
          JSON.stringify(err.response.data, null, 2)
        );
      }

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
  }
);

// Check Duplicate Trail Record
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
      }
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
      error.response?.data || error.message
    );
    return res.status(500).json({
      success: false,
      message: "Error checking for duplicates",
      error: error.response?.data || error.message,
    });
  }
});

// Get Encrypted Gemini Key
app.get("/config/encrypted-key", (req, res) => {
  try {
    if (!process.env.GEMINI_KEY) {
      return res.status(500).json({ error: "GEMINI_KEY not configured" });
    }
    if (!process.env.AES_SECRET) {
      return res.status(500).json({ error: "AES_SECRET not configured" });
    }
    
    const encryptedKey = encrypt(process.env.GEMINI_KEY);
    res.json({ encryptedKey });
  } catch (err) {
    console.error("Encryption failed:", err);
    res.status(500).json({ error: "Encryption failed" });
  }
});

// AI Proxy
app.post("/ai/generate", async (req, res) => {
  try {
    const { prompt, encryptedKey } = req.body;
    
    if (!prompt || !encryptedKey) {
      return res.status(400).json({ error: "Prompt and encrypted key are required" });
    }

    const decryptedKey = decrypt(encryptedKey);
    if (!decryptedKey) {
      return res.status(400).json({ error: "Invalid encrypted key" });
    }

    const aiRes = await axios.post(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
      { contents: [{ parts: [{ text: prompt }] }] },
      { 
        params: { key: decryptedKey },
        timeout: 30000 
      }
    );

    res.json(aiRes.data);
  } catch (err) {
    console.error("AI Error:", err.response?.data || err.message);
    res.status(500).json({ 
      error: "Gemini request failed",
      details: err.response?.data || err.message 
    });
  }
});

// Token Refresh Endpoint
app.get("/api/zoho/refresh-token", async (req, res) => {
  try {
    zohoAccessToken = null;
    tokenExpiryTime = null;
    
    const token = await getZohoAccessToken();
    
    res.json({
      success: true,
      message: "Token refreshed successfully",
      tokenExpiry: new Date(tokenExpiryTime).toISOString(),
    });
  } catch (error) {
    console.error("Token refresh error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to refresh token",
      error: error.message,
    });
  }
});

// Start Server
app.listen(PORT, function () {
  console.log("🚀 Server running on port " + PORT);
  console.log("✅ Zoho Token Management Enabled");
  console.log("✅ AI Encryption Enabled");
});