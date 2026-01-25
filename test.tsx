Here's the complete updated code for both files:

## 1. Updated `vendorAiService.ts` with Enhanced System Prompt

```typescript
// vendorAiService.ts — Enhanced for Purchase Request Item Extraction
import { GoogleGenAI } from "@google/genai";
import { VendorExtractionResult, VendorFileData, PurchaseRequestItem } from "@/vendorTypes";
import CryptoJS from "crypto-js";
import axios from "axios";
import { AIProvider } from "@/types";

// ---------------- ENHANCED SYSTEM PROMPT ----------------
const SYSTEM_PROMPT = `
You are an expert in extracting vendor/supplier information AND purchase order/item details from invoices, quotations, purchase orders, bills, business cards, GST certificates, and registration documents.

Extract TWO sets of information:

1. VENDOR INFORMATION:
{
  "Vendor_Name": "string",
  "Email": "string",
  "Phone": "string",
  "Website": "string",
  "Owner_Name": "string",
  "Supplier_Code": "string",
  "Vendor_Owner": "string",
  "Payment_Terms": "string",
  "Currency": "string",
  "Source": "string",
  "GSTIN_NUMBER": "string",
  "Type_of_Supplier": "string",
  "Street": "string",
  "City": "string",
  "State": "string",
  "Zip_Code": "string",
  "Country": "string",
  "Description": "string",
  "extractedText": "string",
  "accountNumber": "string",
  "ifscCode": "string",
  "bankName": "string",
  "branch": "string",
  "gstin": "string"
}

2. PURCHASE REQUEST ITEMS (if found in document):
{
  "purchaseItems": [
    {
      "name": "string",
      "sku": "string",
      "quantity": number,
      "rate": number,
      "tax_percentage": number,
      "hsn_sac": "string",
      "description": "string",
      "unit": "string"
    }
  ],
  "warehouse": "string",
  "expected_delivery_date": "string",
  "tag": "string",
  "exchange_rate": number
}

RULES FOR VENDOR EXTRACTION:
- GSTIN must be exactly 15 characters (if provided).
- Extract full address and split into Street, City, State, Zip_Code, Country.
- Supplier_Code = generate from vendor name initials if missing.
- Currency default = "INR".
- Country default = "India".
- Payment_Terms default = "Default".
- Type_of_Supplier can be: "Registered", "Unregistered", "Composition", "SEZ", "Deemed Export".
- Keep missing vendor fields empty "".
- For phone numbers, include country code if available.

RULES FOR PURCHASE ITEM EXTRACTION:
- Look for tables or lists with items, products, services in the document.
- Extract item name, quantity, rate, and tax if available.
- If SKU is not found, generate from item name.
- If HSN/SAC is not found, leave empty.
- Default tax percentage is 18% if not specified.
- Default unit is "Nos" if not specified.
- If no items found, return empty array.

FINAL OUTPUT FORMAT:
Return a SINGLE JSON object with both vendor info AND purchase items:
{
  "vendorData": { ... },
  "purchaseRequestData": { ... }
}

IMPORTANT: Always extract all available item information from invoices or purchase orders.
`;

let encryptedKey = "";

// ================================
// LOAD ENCRYPTED KEY FROM BACKEND
// ================================
export async function loadVendorEncryptedKey() {
  const res = await axios.get("http://localhost:5000/config/encrypted-key");
  encryptedKey = res.data.encryptedKey;
  console.log("🔐 Vendor Encrypted key loaded:", encryptedKey);
}

// ================================
// DECRYPT FUNCTION (crypto-js)
// ================================
function decrypt(text: string) {
  try {
    const bytes = CryptoJS.AES.decrypt(
      text,
      import.meta.env.VITE_AES_SECRET
    );
    const result = bytes.toString(CryptoJS.enc.Utf8);
    return result;
  } catch (err) {
    console.error("Decryption failed:", err);
    return "";
  }
}

// ---------------- MAIN FUNCTION ----------------
export const extractVendorInfo = async (
  fileData: VendorFileData,
  config: any
): Promise<{
  vendorData: any;
  purchaseRequestData: any;
  rawText: string;
  modelUsed: string;
  confidenceScore: number;
}> => {
  const { base64, mimeType, textContent } = fileData;
  const base64Pure = base64.split(",")[1] || base64;

  if (config.provider === AIProvider.GEMINI) {
    // 1️⃣ DECRYPT KEY HERE
    const decryptedKey = decrypt(encryptedKey);
    console.log("🔓 Decrypted Gemini Key:", decryptedKey);

    if (!decryptedKey) throw new Error("Gemini key decryption failed.");

    const ai = new GoogleGenAI({ apiKey: decryptedKey });

    let parts: any[] = [{ text: SYSTEM_PROMPT }];

    if (mimeType === "text/plain" && textContent) {
      parts.push({ text: `Source Text Content:\n${textContent}` });
    } else {
      parts.push({
        inlineData: { data: base64Pure, mimeType }
      });
    }

    try {
      const response = await ai.models.generateContent({
        model: config.modelId,
        contents: { parts },
        config: {
          responseMimeType: "application/json",
          temperature: 0.2,
          topP: 0.8,
          topK: 40
        }
      });

      const parsed = JSON.parse(response.text || "{}");
      
      // Extract both vendor and purchase data
      const vendorData = parsed.vendorData || parsed;
      const purchaseRequestData = parsed.purchaseRequestData || {
        items: [],
        warehouse: "Default",
        expected_delivery_date: "",
        tag: "From Vendor Creation",
        exchange_rate: 1
      };

      // ------ FIX DEFAULT VALUES FOR VENDOR ------
      if (!vendorData.Supplier_Code || vendorData.Supplier_Code.trim() === "")
        vendorData.Supplier_Code = generateSupplierCode(vendorData.Vendor_Name || "");

      vendorData.Currency = vendorData.Currency || "INR";
      vendorData.Country = vendorData.Country || "India";
      vendorData.Payment_Terms = vendorData.Payment_Terms || "Default";
      vendorData.Source = vendorData.Source || "Document Upload";
      vendorData.Description = vendorData.Description || "Vendor extracted from uploaded document";
      vendorData.Type_of_Supplier = vendorData.Type_of_Supplier || "Registered";

      // ------ FIX DEFAULT VALUES FOR PURCHASE ITEMS ------
      if (purchaseRequestData.items && purchaseRequestData.items.length > 0) {
        purchaseRequestData.items = purchaseRequestData.items.map((item: any) => ({
          name: item.name || "",
          sku: item.sku || generateSKU(item.name || ""),
          quantity: item.quantity || 1,
          rate: item.rate || 0,
          tax_percentage: item.tax_percentage || 18,
          hsn_sac: item.hsn_sac || "",
          description: item.description || item.name || "",
          unit: item.unit || "Nos"
        }));
      }

      return {
        vendorData,
        purchaseRequestData,
        rawText: vendorData.extractedText || response.text || "",
        modelUsed: config.modelId,
        confidenceScore: 0.95
      };
    } catch (err) {
      console.error("Vendor extraction error:", err);
      throw new Error("Failed to extract vendor and purchase details.");
    }
  }

  // ---------------- OPENAI + GROQ SAME FORMAT ----------------
  if (config.provider === "OPENAI" || config.provider === "GROQ") {
    const isOpenAI = config.provider === "OPENAI";
    const url = isOpenAI
      ? "https://api.openai.com/v1/chat/completions"
      : "https://api.groq.com/openai/v1/chat/completions";

    const apiKey = isOpenAI ? config.keys.OPENAI : config.keys.GROQ;
    if (!apiKey) throw new Error(`Missing API Key for ${config.provider}.`);

    let content: any[] = [{ type: "text", text: SYSTEM_PROMPT }];

    if (mimeType === "text/plain" && textContent) {
      content.push({ type: "text", text: `Source Text:\n${textContent}` });
    } else if (mimeType.startsWith("image/")) {
      content.push({
        type: "image_url",
        image_url: { url: `data:${mimeType};base64,${base64Pure}` }
      });
    } else {
      throw new Error(`${config.provider} supports only text & images.`);
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: config.modelId,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content }],
        temperature: 0.2
      })
    });

    const result = await response.json();
    const resultText = result.choices[0].message.content;
    const parsed = JSON.parse(resultText);

    // Extract both vendor and purchase data
    const vendorData = parsed.vendorData || parsed;
    const purchaseRequestData = parsed.purchaseRequestData || {
      items: [],
      warehouse: "Default",
      expected_delivery_date: "",
      tag: "From Vendor Creation",
      exchange_rate: 1
    };

    // Same default handling for vendor
    if (!vendorData.Supplier_Code || vendorData.Supplier_Code.trim() === "")
      vendorData.Supplier_Code = generateSupplierCode(vendorData.Vendor_Name || "");

    vendorData.Currency = vendorData.Currency || "INR";
    vendorData.Country = vendorData.Country || "India";
    vendorData.Payment_Terms = vendorData.Payment_Terms || "Default";

    // Fix purchase items
    if (purchaseRequestData.items && purchaseRequestData.items.length > 0) {
      purchaseRequestData.items = purchaseRequestData.items.map((item: any) => ({
        name: item.name || "",
        sku: item.sku || generateSKU(item.name || ""),
        quantity: item.quantity || 1,
        rate: item.rate || 0,
        tax_percentage: item.tax_percentage || 18,
        hsn_sac: item.hsn_sac || "",
        description: item.description || item.name || "",
        unit: item.unit || "Nos"
      }));
    }

    return {
      vendorData,
      purchaseRequestData,
      rawText: vendorData.extractedText || resultText,
      modelUsed: config.modelId,
      confidenceScore: 0.95
    };
  }

  throw new Error("Unsupported AI Provider.");
};

// ---------------- UTIL FUNCTIONS ----------------
function generateSupplierCode(name: string): string {
  if (!name) return "SUP";
  const parts = name.toUpperCase().split(/\s+/);
  // Take first 3 words and get first letter of each
  return parts.slice(0, 3).map(w => w.charAt(0)).join("") || "SUP";
}

function generateSKU(itemName: string): string {
  if (!itemName) return "";
  const words = itemName.toUpperCase().split(/\s+/);
  // Create SKU from first 3 characters of each word (max 3 words)
  return words.slice(0, 3).map(word => word.substring(0, 3)).join("") || "ITEM";
}

// Export type for purchase items
export interface PurchaseItem {
  name: string;
  sku: string;
  quantity: number;
  rate: number;
  tax_percentage: number;
  hsn_sac: string;
  description: string;
  unit: string;
}
```

## 2. Updated `vendorTypes.ts` (Add this file if not exists)

```typescript
// vendorTypes.ts
export interface VendorData {
  Vendor_Name: string;
  Email: string;
  Phone: string;
  Website: string;
  Owner_Name: string;
  Supplier_Code: string;
  Vendor_Owner: string;
  Payment_Terms: string;
  Currency: string;
  Source: string;
  GSTIN_NUMBER: string;
  Type_of_Supplier: string;
  Street: string;
  City: string;
  State: string;
  Zip_Code: string;
  Country: string;
  Description: string;
  accountNumber: string;
  ifscCode: string;
  bankName: string;
  branch: string;
  gstin: string;
}

export interface PurchaseRequestItem {
  name: string;
  sku: string;
  quantity: number;
  rate: number;
  tax_percentage: number;
  hsn_sac: string;
  description: string;
  unit: string;
}

export interface PurchaseRequestData {
  items: PurchaseRequestItem[];
  warehouse: string;
  expected_delivery_date: string;
  tag: string;
  exchange_rate: number;
}

export interface VendorFileData {
  fileName: string;
  fileSize: number;
  mimeType: string;
  previewUrl: string;
  originalFile: File;
  base64: string;
  textContent?: string;
}

export interface VendorExtractionResult {
  vendorData: VendorData;
  purchaseRequestData: PurchaseRequestData;
  rawText: string;
  modelUsed: string;
  confidenceScore: number;
  extractedText?: string;
}
```

## 3. Updated `VendorResultView.tsx` with Purchase Request Section

```tsx
// VendorResultView.tsx
import React, { useState, useEffect } from 'react';
import { VendorExtractionResult, VendorFileData, VendorData, PurchaseRequestItem } from '../vendorTypes';
import axios from 'axios';

interface VendorResultViewProps {
  result: VendorExtractionResult;
  file: VendorFileData;
  onReset: () => void;
}

const PAYMENT_TERMS_OPTIONS = [
  "Default",
  "Net 7",
  "Net 15",
  "Net 30",
  "Net 60",
  "Immediate",
  "End of Month",
  "Cash on Delivery",
  "Advance Payment"
];

const CURRENCY_OPTIONS = ["INR", "USD", "EUR", "GBP", "AED", "SAR"];
const SUPPLIER_TYPES = ["Registered", "Unregistered", "Composition", "SEZ", "Deemed Export"];
const COUNTRIES = ["India", "USA", "UK", "UAE", "Singapore", "Other"];
const UNIT_OPTIONS = ["Nos", "Kg", "Ltr", "Meter", "Box", "Set", "Pair", "Unit", "Dozen", "Pack"];

export const VendorResultView: React.FC<VendorResultViewProps> = ({ result, file, onReset }) => {
  const [data, setData] = useState<VendorData>(result.vendorData);
  const [purchaseRequestData, setPurchaseRequestData] = useState({
    items: result.purchaseRequestData?.items || [
      {
        name: '',
        sku: '',
        quantity: 1,
        rate: 0,
        tax_percentage: 18,
        hsn_sac: '',
        description: '',
        unit: 'Nos'
      }
    ],
    warehouse: result.purchaseRequestData?.warehouse || 'Default',
    expected_delivery_date: result.purchaseRequestData?.expected_delivery_date || '',
    tag: result.purchaseRequestData?.tag || 'From Vendor Creation',
    exchange_rate: result.purchaseRequestData?.exchange_rate || 1
  });
  
  const [copied, setCopied] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showPurchaseSection, setShowPurchaseSection] = useState(
    result.purchaseRequestData?.items && result.purchaseRequestData.items.length > 0
  );

  const handleFieldChange = (field: keyof VendorData, value: string) => {
    setData(prev => ({ ...prev, [field]: value }));
  };

  const handlePurchaseItemChange = (index: number, field: keyof PurchaseRequestItem | 'unit', value: any) => {
    setPurchaseRequestData(prev => ({
      ...prev,
      items: prev.items.map((item, i) => 
        i === index ? { ...item, [field]: value } : item
      )
    }));
  };

  const handlePurchaseRequestChange = (field: keyof typeof purchaseRequestData, value: any) => {
    if (field === 'items') return; // Handle items separately
    setPurchaseRequestData(prev => ({ ...prev, [field]: value }));
  };

  const addPurchaseItem = () => {
    setPurchaseRequestData(prev => ({
      ...prev,
      items: [
        ...prev.items,
        {
          name: '',
          sku: '',
          quantity: 1,
          rate: 0,
          tax_percentage: 18,
          hsn_sac: '',
          description: '',
          unit: 'Nos'
        }
      ]
    }));
  };

  const removePurchaseItem = (index: number) => {
    if (purchaseRequestData.items.length > 1) {
      setPurchaseRequestData(prev => ({
        ...prev,
        items: prev.items.filter((_, i) => i !== index)
      }));
    }
  };

  const calculateItemTotal = (item: PurchaseRequestItem) => {
    const subtotal = item.quantity * item.rate;
    const tax = subtotal * (item.tax_percentage / 100);
    return subtotal + tax;
  };

  const calculateGrandTotal = () => {
    return purchaseRequestData.items.reduce((total, item) => total + calculateItemTotal(item), 0);
  };

  const copyJSON = () => {
    const allData = {
      vendorData: data,
      purchaseRequestData: purchaseRequestData
    };
    navigator.clipboard.writeText(JSON.stringify(allData, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const validateGSTIN = (gstin: string): boolean => {
    if (!gstin) return true; // Empty is okay
    const gstinRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
    return gstinRegex.test(gstin);
  };

  const validateRequiredFields = (): string[] => {
    const required: (keyof VendorData)[] = [
      "Vendor_Name",
      "Supplier_Code",
      "GSTIN_NUMBER",
      "Type_of_Supplier",
      "Street",
      "City",
      "State",
      "Country"
    ];

    const missing: string[] = [];
    required.forEach(field => {
      if (!data[field] || data[field].toString().trim() === "") {
        missing.push(field);
      }
    });

    // Validate purchase items if section is shown
    if (showPurchaseSection) {
      purchaseRequestData.items.forEach((item, index) => {
        if (!item.name || item.name.trim() === "") {
          missing.push(`Item ${index + 1} Name`);
        }
      });
    }

    return missing;
  };

  const handleSubmit = async () => {
    // Validate GSTIN
    if (data.GSTIN_NUMBER && !validateGSTIN(data.GSTIN_NUMBER)) {
      setSubmitError("Invalid GSTIN format. Must be 15 characters (e.g., 08ACAPG1208G1ZI)");
      return;
    }

    // Validate required fields
    const missingFields = validateRequiredFields();
    if (missingFields.length > 0) {
      setSubmitError(`Please fill required fields: ${missingFields.join(", ")}`);
      return;
    }

    // Validate purchase items
    if (showPurchaseSection) {
      const invalidItems = purchaseRequestData.items.filter(item => 
        item.quantity <= 0 || item.rate < 0
      );
      if (invalidItems.length > 0) {
        setSubmitError("Please check item quantities and rates (must be positive)");
        return;
      }
    }

    setSubmitting(true);
    setSubmitError(null);

    try {
      const API_ENDPOINT = "https://elec-zoho-backend-snowy.vercel.app/api/vendors";

      const formData = new FormData();
      formData.append("file", file.originalFile);
      formData.append("vendorData", JSON.stringify(data));
      
      // Only send purchase request data if section is shown and has items
      if (showPurchaseSection && purchaseRequestData.items.some(item => item.name.trim() !== "")) {
        formData.append("purchaseRequestData", JSON.stringify(purchaseRequestData));
      }
      
      formData.append("processed_at", new Date().toISOString());

      const response = await axios.post(API_ENDPOINT, formData, {
        headers: { "Content-Type": "application/json" }
      });

      if (response.status === 200 || response.status === 201) {
        setShowSuccess(true);
      } else {
        throw new Error(`Server responded ${response.status}`);
      }
    } catch (err: any) {
      console.error("Vendor submission failed:", err);
      setSubmitError(
        err.response?.data?.message ||
        err.message ||
        "Failed to create vendor. Please try again."
      );
    } finally {
      setSubmitting(false);
    }
  };

  const isImage = file.mimeType.startsWith('image/');
  const isPdf = file.mimeType === 'application/pdf';

  // Extract vendor info from AI result for summary
  const extractedItemCount = result.purchaseRequestData?.items?.length || 0;

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 flex flex-col gap-6 relative">
      {/* Success Popup */}
      {showSuccess && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm animate-in fade-in duration-300">
          <div className="bg-white rounded-3xl shadow-2xl p-8 max-w-sm w-full text-center animate-in zoom-in-95 duration-300">
            <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-6">
              <svg className="w-10 h-10 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h3 className="text-2xl font-bold text-gray-900 mb-2">Vendor Created!</h3>
            <p className="text-gray-500 mb-8 text-sm leading-relaxed">
              Vendor "{data.Vendor_Name}" has been successfully created in the system.
              {purchaseRequestData.items.some(item => item.name.trim() !== "") && 
                " Purchase request has also been created."}
            </p>
            <button
              onClick={onReset}
              className="w-full py-4 bg-green-600 text-white font-bold rounded-2xl hover:bg-green-700 transition-colors shadow-lg active:scale-95"
            >
              Create Another Vendor
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-col md:flex-row items-center justify-between gap-4">
        <div>
          <h2 className="text-3xl font-bold text-gray-900 tracking-tight">Vendor Creation</h2>
          <p className="text-gray-500 text-sm font-medium">Extracted from: <span className="text-green-600 italic">{file.fileName}</span></p>
          <p className="text-xs text-green-600 font-medium">
            ✓ AI has automatically extracted vendor details from the document
            {extractedItemCount > 0 && ` and ${extractedItemCount} item(s) for purchase request`}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={copyJSON}
            className={`px-4 py-2.5 text-xs font-bold rounded-xl border transition-all tracking-widest ${copied ? 'bg-green-50 border-green-200 text-green-600' : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'
              }`}
          >
            {copied ? 'JSON COPIED' : 'COPY JSON'}
          </button>
          <button
            onClick={onReset}
            className="px-6 py-2.5 border border-gray-200 text-gray-700 font-bold rounded-xl hover:bg-gray-50 transition-colors text-sm"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className={`px-8 py-2.5 bg-green-600 text-white font-bold rounded-xl hover:bg-green-700 transition-colors shadow-lg shadow-green-100 text-sm flex items-center gap-2 ${submitting ? 'opacity-70 cursor-not-allowed' : ''}`}
          >
            {submitting ? (
              <>
                <svg className="animate-spin h-4 w-4 text-white" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                Creating...
              </>
            ) : 'Create Vendor'}
          </button>
        </div>
      </div>

      {submitError && (
        <div className="bg-red-50 border border-red-100 p-4 rounded-2xl flex items-center gap-3 animate-in slide-in-from-top-2 duration-300">
          <svg className="w-5 h-5 text-red-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
          <p className="text-sm text-red-700 font-medium">{submitError}</p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left: Source Preview */}
        <div className="lg:col-span-5 space-y-4">
          <h3 className="text-[10px] font-bold text-gray-400 uppercase tracking-widest px-1">Source Document</h3>
          <div className="bg-white p-2 rounded-2xl border border-gray-200 shadow-sm sticky top-24 min-h-[400px] flex items-center justify-center overflow-hidden">
            {isImage ? (
              <img
                src={file.previewUrl}
                alt="Vendor Document"
                className="w-full h-auto rounded-lg object-contain max-h-[70vh]"
              />
            ) : isPdf ? (
              <iframe
                src={file.previewUrl}
                className="w-full h-[70vh] rounded-lg"
                title="Vendor Document Preview"
              />
            ) : (
              <div className="flex flex-col items-center p-12 text-center">
                <div className="w-16 h-16 bg-gray-50 rounded-2xl flex items-center justify-center mb-4">
                  <svg className="w-8 h-8 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                  </svg>
                </div>
                <p className="text-sm font-bold text-gray-900">{file.fileName}</p>
                <p className="text-xs text-gray-500 mt-1 uppercase tracking-wider">{file.mimeType.split('/')[1] || 'Document'}</p>
              </div>
            )}
          </div>

          {/* AI Extraction Summary */}
          <div className="bg-green-50 border border-green-200 rounded-2xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <svg className="w-4 h-4 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="text-xs font-bold text-green-700 uppercase">AI Extracted Details</span>
            </div>
            <div className="text-sm text-gray-700 space-y-1">
              <p><span className="font-medium">Vendor:</span> {data.Vendor_Name}</p>
              <p><span className="font-medium">Supplier Code:</span> {data.Supplier_Code}</p>
              {data.GSTIN_NUMBER && <p><span className="font-medium">GSTIN:</span> {data.GSTIN_NUMBER}</p>}
              {data.City && <p><span className="font-medium">Location:</span> {data.City}, {data.State}</p>}
              {extractedItemCount > 0 && (
                <p><span className="font-medium">Items Found:</span> {extractedItemCount} item(s)</p>
              )}
            </div>
          </div>

          {/* Purchase Request Toggle */}
          <div className="bg-gray-50 border border-gray-200 rounded-2xl p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <svg className="w-4 h-4 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
                <span className="text-sm font-bold text-gray-700">Create Purchase Request</span>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={showPurchaseSection}
                  onChange={(e) => setShowPurchaseSection(e.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-gray-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-green-600"></div>
              </label>
            </div>
            <p className="text-xs text-gray-500 mt-2">
              {showPurchaseSection 
                ? "Purchase request will be created with the vendor"
                : "Only vendor will be created"}
            </p>
          </div>
        </div>

        {/* Right: Vendor Form & Purchase Request */}
        <div className="lg:col-span-7 space-y-6">
          {/* Vendor Information Card */}
          <div className="bg-white rounded-3xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="px-6 py-4 bg-gray-50 border-b flex items-center justify-between">
              <span className="text-sm font-bold text-gray-700">Vendor Information</span>
              <span className="text-[10px] bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-bold uppercase">
                Auto-Extracted
              </span>
            </div>

            <div className="p-6 space-y-5">
              {/* Basic Information */}
              <div className="space-y-4">
                <h4 className="text-xs font-bold text-gray-600 uppercase tracking-wider border-b pb-2">Basic Details</h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <FormField
                    label="Vendor Name *"
                    value={data.Vendor_Name}
                    onChange={(v) => handleFieldChange("Vendor_Name", v)}
                    placeholder="Company/Business Name"
                    required
                  />
                  <FormField
                    label="Supplier Code *"
                    value={data.Supplier_Code}
                    onChange={(v) => handleFieldChange("Supplier_Code", v)}
                    placeholder="e.g., GVA, INF, REL"
                    required
                  />
                  <FormField
                    label="Owner Name"
                    value={data.Owner_Name}
                    onChange={(v) => handleFieldChange("Owner_Name", v)}
                    placeholder="Proprietor/Owner name"
                  />
                  <FormField
                    label="Vendor Owner (Contact Person)"
                    value={data.Vendor_Owner}
                    onChange={(v) => handleFieldChange("Vendor_Owner", v)}
                    placeholder="Person in charge"
                  />
                  <FormField
                    label="Email"
                    type="email"
                    value={data.Email}
                    onChange={(v) => handleFieldChange("Email", v)}
                    placeholder="vendor@example.com"
                  />
                  <FormField
                    label="Phone *"
                    value={data.Phone}
                    onChange={(v) => handleFieldChange("Phone", v)}
                    placeholder="+91-XXXXXXXXXX"
                  />
                  <FormField
                    label="Website"
                    value={data.Website}
                    onChange={(v) => handleFieldChange("Website", v)}
                    placeholder="https://www.example.com"
                  />
                </div>
              </div>

              {/* Tax Information */}
              <div className="space-y-4 pt-4 border-t border-gray-100">
                <h4 className="text-xs font-bold text-gray-600 uppercase tracking-wider border-b pb-2">Tax & Registration</h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold text-gray-600 ml-1 uppercase tracking-tighter">
                      GSTIN Number *
                      {data.GSTIN_NUMBER && !validateGSTIN(data.GSTIN_NUMBER) && (
                        <span className="text-red-500 ml-1">⚠ Invalid format</span>
                      )}
                    </label>
                    <input
                      type="text"
                      value={data.GSTIN_NUMBER}
                      onChange={(e) => handleFieldChange("GSTIN_NUMBER", e.target.value.toUpperCase())}
                      placeholder="08ACAPG1208G1ZI"
                      className={`w-full bg-gray-50 border ${validateGSTIN(data.GSTIN_NUMBER) || !data.GSTIN_NUMBER ? 'border-gray-200' : 'border-red-300'} rounded-xl px-4 py-2.5 text-sm text-gray-900 font-medium outline-none focus:ring-2 focus:ring-green-500 transition-all`}
                    />
                    <p className="text-[10px] text-gray-400 mt-1">15 characters, e.g., 08ACAPG1208G1ZI</p>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold text-gray-600 ml-1 uppercase tracking-tighter">
                      Type of Supplier *
                    </label>
                    <select
                      value={data.Type_of_Supplier}
                      onChange={(e) => handleFieldChange("Type_of_Supplier", e.target.value)}
                      className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5 text-sm text-gray-900 font-medium outline-none focus:ring-2 focus:ring-green-500 transition-all"
                    >
                      <option value="">Select Type</option>
                      {SUPPLIER_TYPES.map(type => <option key={type} value={type}>{type}</option>)}
                    </select>
                  </div>
                </div>
              </div>

              {/* Address */}
              <div className="space-y-4 pt-4 border-t border-gray-100">
                <h4 className="text-xs font-bold text-gray-600 uppercase tracking-wider border-b pb-2">Address Details</h4>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-bold text-gray-600 ml-1 uppercase tracking-tighter">Street Address *</label>
                  <textarea
                    value={data.Street}
                    onChange={(e) => handleFieldChange("Street", e.target.value)}
                    rows={2}
                    className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm text-gray-900 outline-none focus:ring-2 focus:ring-green-500 transition-all resize-none"
                    placeholder="Building name, street, area"
                  />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
                  <FormField
                    label="City *"
                    value={data.City}
                    onChange={(v) => handleFieldChange("City", v)}
                    placeholder="City"
                    required
                  />
                  <FormField
                    label="State *"
                    value={data.State}
                    onChange={(v) => handleFieldChange("State", v)}
                    placeholder="State"
                    required
                  />
                  <FormField
                    label="Zip Code *"
                    value={data.Zip_Code}
                    onChange={(v) => handleFieldChange("Zip_Code", v)}
                    placeholder="PIN Code"
                    required
                  />
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold text-gray-600 ml-1 uppercase tracking-tighter">Country *</label>
                    <select
                      value={data.Country}
                      onChange={(e) => handleFieldChange("Country", e.target.value)}
                      className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5 text-sm text-gray-900 font-medium outline-none focus:ring-2 focus:ring-green-500 transition-all"
                    >
                      {COUNTRIES.map(country => <option key={country} value={country}>{country}</option>)}
                    </select>
                  </div>
                </div>
              </div>

              {/* Financial Details */}
              <div className="space-y-4 pt-4 border-t border-gray-100">
                <h4 className="text-xs font-bold text-gray-600 uppercase tracking-wider border-b pb-2">Financial Settings</h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold text-gray-600 ml-1 uppercase tracking-tighter">Payment Terms</label>
                    <select
                      value={data.Payment_Terms}
                      onChange={(e) => handleFieldChange("Payment_Terms", e.target.value)}
                      className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5 text-sm text-gray-900 font-medium outline-none focus:ring-2 focus:ring-green-500 transition-all"
                    >
                      {PAYMENT_TERMS_OPTIONS.map(term => <option key={term} value={term}>{term}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold text-gray-600 ml-1 uppercase tracking-tighter">Currency</label>
                    <select
                      value={data.Currency}
                      onChange={(e) => handleFieldChange("Currency", e.target.value)}
                      className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5 text-sm text-gray-900 font-medium outline-none focus:ring-2 focus:ring-green-500 transition-all"
                    >
                      {CURRENCY_OPTIONS.map(currency => <option key={currency} value={currency}>{currency}</option>)}
                    </select>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-bold text-gray-600 ml-1 uppercase tracking-tighter">Source</label>
                  <input
                    type="text"
                    value={data.Source}
                    onChange={(e) => handleFieldChange("Source", e.target.value)}
                    className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5 text-sm text-gray-900 font-medium outline-none focus:ring-2 focus:ring-green-500 transition-all"
                    placeholder="How was this vendor sourced?"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-bold text-gray-600 ml-1 uppercase tracking-tighter">Description</label>
                  <textarea
                    value={data.Description}
                    onChange={(e) => handleFieldChange("Description", e.target.value)}
                    rows={2}
                    className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm text-gray-900 outline-none focus:ring-2 focus:ring-green-500 transition-all resize-none"
                    placeholder="Additional notes about this vendor"
                  />
                </div>
                
                {/* Bank Details */}
                <div className="space-y-4 pt-4 border-t border-gray-100">
                  <h4 className="text-xs font-bold text-gray-600 uppercase tracking-wider border-b pb-2">
                    Bank Details
                  </h4>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <FormField
                      label="Account Number"
                      value={data.accountNumber}
                      onChange={(v) => handleFieldChange("accountNumber", v)}
                      placeholder="Bank account number"
                    />

                    <FormField
                      label="IFSC Code"
                      value={data.ifscCode}
                      onChange={(v) => handleFieldChange("ifscCode", v.toUpperCase())}
                      placeholder="e.g., HDFC0001234"
                    />

                    <FormField
                      label="Bank Name"
                      value={data.bankName}
                      onChange={(v) => handleFieldChange("bankName", v)}
                      placeholder="Bank name"
                    />

                    <FormField
                      label="Branch"
                      value={data.branch}
                      onChange={(v) => handleFieldChange("branch", v)}
                      placeholder="Branch name"
                    />

                    <FormField
                      label="GSTIN (Alt Field)"
                      value={data.gstin}
                      onChange={(v) => handleFieldChange("gstin", v.toUpperCase())}
                      placeholder="08ACAPG1208G1ZI"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Purchase Request Section - Conditionally Rendered */}
          {showPurchaseSection && (
            <div className="bg-white rounded-3xl border border-gray-200 shadow-sm overflow-hidden">
              <div className="px-6 py-4 bg-blue-50 border-b flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <svg className="w-5 h-5 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                  </svg>
                  <span className="text-sm font-bold text-gray-700">Purchase Request Details</span>
                </div>
                <span className="text-[10px] bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-bold uppercase">
                  Auto-Extracted
                </span>
              </div>

              <div className="p-6 space-y-5">
                {/* Purchase Request Settings */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold text-gray-600 ml-1 uppercase tracking-tighter">Warehouse</label>
                    <input
                      type="text"
                      value={purchaseRequestData.warehouse}
                      onChange={(e) => handlePurchaseRequestChange("warehouse", e.target.value)}
                      className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5 text-sm text-gray-900 font-medium outline-none focus:ring-2 focus:ring-blue-500 transition-all"
                      placeholder="Default Warehouse"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold text-gray-600 ml-1 uppercase tracking-tighter">Expected Delivery Date</label>
                    <input
                      type="date"
                      value={purchaseRequestData.expected_delivery_date}
                      onChange={(e) => handlePurchaseRequestChange("expected_delivery_date", e.target.value)}
                      className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5 text-sm text-gray-900 font-medium outline-none focus:ring-2 focus:ring-blue-500 transition-all"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold text-gray-600 ml-1 uppercase tracking-tighter">Tag</label>
                    <input
                      type="text"
                      value={purchaseRequestData.tag}
                      onChange={(e) => handlePurchaseRequestChange("tag", e.target.value)}
                      className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5 text-sm text-gray-900 font-medium outline-none focus:ring-2 focus:ring-blue-500 transition-all"
                      placeholder="Purchase Request Tag"
                    />
                  </div>
                </div>

                {/* Purchase Items */}
                <div className="space-y-4">
                  <div className="flex justify-between items-center">
                    <h4 className="text-xs font-bold text-gray-600 uppercase tracking-wider">Purchase Items</h4>
                    <button
                      type="button"
                      onClick={addPurchaseItem}
                      className="text-xs bg-green-600 text-white px-3 py-1.5 rounded-lg hover:bg-green-700 transition-colors flex items-center gap-1"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                      </svg>
                      Add Item
                    </button>
                  </div>

                  {purchaseRequestData.items.map((item, index) => (
                    <div key={index} className="border border-gray-200 rounded-xl p-4 space-y-4">
                      <div className="flex justify-between items-center">
                        <h5 className="text-sm font-bold text-gray-700">Item #{index + 1}</h5>
                        {purchaseRequestData.items.length > 1 && (
                          <button
                            type="button"
                            onClick={() => removePurchaseItem(index)}
                            className="text-red-500 hover:text-red-700 text-sm flex items-center gap-1"
                          >
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                            Remove
                          </button>
                        )}
                      </div>
                      
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <FormField
                          label="Item Name *"
                          value={item.name}
                          onChange={(v) => handlePurchaseItemChange(index, 'name', v)}
                          placeholder="Enter item name"
                          required
                        />
                        <FormField
                          label="SKU"
                          value={item.sku}
                          onChange={(v) => handlePurchaseItemChange(index, 'sku', v)}
                          placeholder="Enter SKU"
                        />
                        <div className="space-y-1.5">
                          <label className="text-[10px] font-bold text-gray-600 ml-1 uppercase tracking-tighter">Unit</label>
                          <select
                            value={item.unit}
                            onChange={(e) => handlePurchaseItemChange(index, 'unit', e.target.value)}
                            className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5 text-sm text-gray-900 font-medium outline-none focus:ring-2 focus:ring-blue-500 transition-all"
                          >
                            {UNIT_OPTIONS.map(unit => <option key={unit} value={unit}>{unit}</option>)}
                          </select>
                        </div>
                        <FormField
                          label="Quantity"
                          value={item.quantity.toString()}
                          onChange={(v) => handlePurchaseItemChange(index, 'quantity', parseInt(v) || 1)}
                          type="number"
                          placeholder="Enter quantity"
                        />
                        <FormField
                          label="Rate"
                          value={item.rate.toString()}
                          onChange={(v) => handlePurchaseItemChange(index, 'rate', parseFloat(v) || 0)}
                          type="number"
                          placeholder="Enter rate"
                        />
                        <FormField
                          label="Tax %"
                          value={item.tax_percentage.toString()}
                          onChange={(v) => handlePurchaseItemChange(index, 'tax_percentage', parseFloat(v) || 0)}
                          type="number"
                          placeholder="Enter tax percentage"
                        />
                        <FormField
                          label="HSN/SAC"
                          value={item.hsn_sac}
                          onChange={(v) => handlePurchaseItemChange(index, 'hsn_sac', v)}
                          placeholder="Enter HSN/SAC code"
                        />
                      </div>
                      
                      <div className="space-y-1.5">
                        <label className="text-[10px] font-bold text-gray-600 ml-1 uppercase tracking-tighter">
                          Description
                        </label>
                        <textarea
                          value={item.description}
                          onChange={(e) => handlePurchaseItemChange(index, 'description', e.target.value)}
                          rows={2}
                          className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm text-gray-900 outline-none focus:ring-2 focus:ring-blue-500 transition-all resize-none"
                          placeholder="Item description"
                        />
                      </div>

                      {/* Item Summary */}
                      <div className="bg-gray-50 rounded-lg p-3">
                        <div className="flex justify-between text-sm">
                          <span className="text-gray-600">Subtotal:</span>
                          <span className="font-bold">₹{(item.quantity * item.rate).toFixed(2)}</span>
                        </div>
                        <div className="flex justify-between text-sm">
                          <span className="text-gray-600">Tax ({item.tax_percentage}%):</span>
                          <span className="font-bold">₹{(item.quantity * item.rate * item.tax_percentage / 100).toFixed(2)}</span>
                        </div>
                        <div className="flex justify-between text-sm mt-2 pt-2 border-t">
                          <span className="text-gray-700 font-bold">Total:</span>
                          <span className="text-green-600 font-bold">₹{calculateItemTotal(item).toFixed(2)}</span>
                        </div>
                      </div>
                    </div>
                  ))}

                  {/* Grand Total */}
                  {purchaseRequestData.items.length > 0 && (
                    <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
                      <div className="flex justify-between items-center">
                        <div>
                          <h5 className="text-sm font-bold text-gray-700">Purchase Request Summary</h5>
                          <p className="text-xs text-gray-500">{purchaseRequestData.items.length} item(s)</p>
                        </div>
                        <div className="text-right">
                          <p className="text-sm text-gray-600">Grand Total</p>
                          <p className="text-2xl font-bold text-green-600">₹{calculateGrandTotal().toFixed(2)}</p>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Bottom Submit Button */}
          <div className="pt-2">
            <button
              onClick={handleSubmit}
              disabled={submitting}
              className={`w-full py-5 ${showPurchaseSection ? 'bg-blue-600 shadow-blue-100 hover:bg-blue-700' : 'bg-green-600 shadow-green-100 hover:bg-green-700'} text-white font-extrabold rounded-3xl transition-all shadow-xl flex items-center justify-center gap-3 text-lg uppercase tracking-wider active:scale-[0.98] ${submitting ? 'opacity-70 cursor-not-allowed' : ''}`}
            >
              {submitting ? (
                <>
                  <svg className="animate-spin h-6 w-6 text-white" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                  {showPurchaseSection ? 'Creating Vendor & Purchase Request...' : 'Creating Vendor...'}
                </>
              ) : (
                <>
                  {showPurchaseSection ? 'Create Vendor & Purchase Request' : 'Create Vendor in System'}
                  {showPurchaseSection && (
                    <span className="text-sm bg-white/20 px-2 py-1 rounded-lg">
                      Total: ₹{calculateGrandTotal().toFixed(2)}
                    </span>
                  )}
                </>
              )}
            </button>
          </div>

          <div className="bg-green-50/30 border border-green-100 p-4 rounded-2xl flex gap-3">
            <svg className="w-5 h-5 text-green-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            <p className="text-xs text-gray-600 leading-relaxed font-medium">
              <strong>Note:</strong> AI automatically extracts vendor details. Review and edit any fields as needed. Required fields are marked with *. 
              {showPurchaseSection && ' Purchase request items can be added or modified as needed.'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

interface FormFieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  required?: boolean;
}

const FormField: React.FC<FormFieldProps> = ({ label, value, onChange, type = "text", placeholder, required = false }) => (
  <div className="space-y-1.5">
    <label className="text-[10px] font-bold text-gray-600 ml-1 uppercase tracking-tighter">
      {label}
      {required && <span className="text-red-500 ml-1">*</span>}
    </label>
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={`w-full bg-gray-50 border ${required && !value ? 'border-red-200 bg-red-50/50' : 'border-gray-200'} rounded-xl px-4 py-2.5 text-sm text-gray-900 font-medium outline-none focus:ring-2 focus:ring-green-500 transition-all`}
    />
  </div>
);
```

## Key Features of the Updated Code:

### **vendorAiService.ts Enhancements:**
1. **Enhanced System Prompt** that extracts both vendor info AND purchase items
2. **Dual output structure** - returns both `vendorData` and `purchaseRequestData`
3. **Smart item extraction** - looks for product tables in invoices/documents
4. **Default value handling** for both vendor and purchase items
5. **SKU generation** from item names if not found

### **VendorResultView.tsx Enhancements:**
1. **Purchase Request Toggle** - Option to enable/disable purchase request creation
2. **Dynamic Item Management** - Add/remove items with validation
3. **Real-time Calculations** - Subtotal, tax, and grand total for each item
4. **Auto-extraction Summary** - Shows how many items AI found
5. **Conditional Submission** - Only sends purchase data if section is enabled
6. **Visual Feedback** - Different colors for vendor vs purchase request sections
7. **Comprehensive Validation** - Validates both vendor and purchase item data

### **Backend Integration:**
The backend will now:
1. Check if vendor exists by GSTIN
2. Update if exists, create new if not
3. Create purchase request with all items
4. Link purchase request to vendor
5. Return detailed success/failure information

This solution provides a complete vendor onboarding system with purchase request creation capability, all powered by AI extraction from uploaded documents.
