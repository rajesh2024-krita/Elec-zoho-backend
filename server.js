const express = require("express");
const axios = require("axios");
const cors = require("cors");
const dotenv = require("dotenv");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// 1. Configure Storage for Uploads
const uploadDir = "uploads";
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // Save file with original name + timestamp to avoid overwriting
    const uniqueName = Date.now() + "-" + file.originalname;
    cb(null, uniqueName);
  }
});

const upload = multer({ storage: storage });

const PORT = process.env.PORT || 5000;

// --- ROUTES ---

app.get("/health", (req, res) => {
  res.json({ status: "OK", message: "Backend running" });
});

/**
 * ROUTE: Upload Claim & Notify Webhooks
 * Expects: Multi-part form data (fields + file)
 */
app.post("/api/claims", upload.single("file"), async function (req, res) {
  try {
    const data = req.body;
    const file = req.file;

    if (!data.supplierName) {
      return res.status(400).json({ success: false, message: "Supplier Name required" });
    }

    console.log('data == ', data)
    console.log('file == ', file)

    // Attach file info to the data being sent to webhooks
    const payload = {
      ...data,
      fileName: file ? file.originalname : null,
      serverFileName: file ? file.filename : null,
      downloadUrl: file ? `${req.protocol}://${req.get("host")}/api/download/${file.filename}` : null
    };

    const webhookUrls = process.env.WEBHOOK_URLS
      ? process.env.WEBHOOK_URLS.split(",").map(u => u.trim())
      : [];

    console.log("📦 Processing Claim:", payload.supplierName);

    const requests = webhookUrls.map(url => 
      axios.post(url, payload, {
        headers: { "Content-Type": "application/json" },
        timeout: 10000
      })
    );

    const results = await Promise.allSettled(requests);
    const successCount = results.filter(r => r.status === "fulfilled").length;

    return res.status(200).json({
      success: true,
      message: "Claim and file processed",
      fileSaved: !!file,
      webhookSuccess: successCount
    });

  } catch (error) {
    console.error("🔥 Error:", error.message);
    return res.status(500).json({ success: false, message: "Internal error" });
  }
});

/**
 * ROUTE: Download File
 * This is what allows the "Click to Download" functionality
 */
app.get("/api/download/:filename", function (req, res) {
  const fileName = req.params.filename;
  const filePath = path.join(__dirname, uploadDir, fileName);

  if (fs.existsSync(filePath)) {
    res.download(filePath); 
  } else {
    res.status(404).json({ message: "File not found on server" });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});