require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration from Environment
const CONFIG = {
  merchantId: process.env.MERCHANT_ID || '1035',
  merchantKey: process.env.MERCHANT_KEY || 'wZBwf2XsDXi3uT6VryBXfkAYRzQydZed',
  gatewayUrl: (process.env.GATEWAY_URL || 'https://openapi.talkpayapp.com').replace(/\/+$/, ''),
  callbackIp: process.env.CALLBACK_IP || '54.255.54.222',
  notifyUrl: process.env.NOTIFY_URL || '',
  returnUrl: process.env.RETURN_URL || ''
};

// In-memory order storage for transactions
const ordersDb = new Map();
const callbackLogs = [];

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

/**
 * Generates HMAC-SHA256 Base64 signature according to Solid Border spec:
 * 1. Filter out 'sign', null, undefined, and empty string fields.
 * 2. Sort parameters in ascending ASCII dictionary order (a-z).
 * 3. Concatenate: key1=value1&key2=value2&...
 * 4. Compute Base64(HMAC-SHA256(dataString, secretKey))
 */
function generateSignature(params, secretKey) {
  const sortedKeys = Object.keys(params)
    .filter(k => k !== 'sign' && params[k] !== null && params[k] !== undefined && params[k] !== '')
    .sort();

  const signString = sortedKeys.map(k => `${k}=${params[k]}`).join('&');
  const signature = crypto.createHmac('sha256', secretKey)
    .update(signString, 'utf8')
    .digest('base64');

  return { signature, signString };
}

/**
 * Verify incoming signature from gateway callback
 */
function verifySignature(params, secretKey, expectedSign) {
  const { signature } = generateSignature(params, secretKey);
  return signature === expectedSign;
}

// -------------------------------------------------------------
// API: Get Gateway Status & System Config
// -------------------------------------------------------------
app.get('/api/config', (req, res) => {
  res.json({
    success: true,
    merchantId: CONFIG.merchantId,
    gatewayUrl: CONFIG.gatewayUrl,
    callbackIp: CONFIG.callbackIp,
    maskedKey: CONFIG.merchantKey ? `${CONFIG.merchantKey.slice(0, 4)}••••••••${CONFIG.merchantKey.slice(-4)}` : '',
    minAmount: 100, // INR (100.00)
    maxAmount: 50000, // INR (50000.00)
    currency: 'INR'
  });
});

// -------------------------------------------------------------
// API: Create Payin Order
// -------------------------------------------------------------
app.post('/api/payin/create', async (req, res) => {
  try {
    const {
      amount, // In INR (e.g. 100, 500)
      rawAmount = false,
      outOrderNo: customOrderNo,
      notifyUrl = CONFIG.notifyUrl,
      returnUrl = CONFIG.returnUrl,
      customerNote = ''
    } = req.body;

    if (!amount || isNaN(amount) || Number(amount) <= 0) {
      return res.status(400).json({
        success: false,
        msg: 'Please enter a valid positive amount.'
      });
    }

    // Amount calculation:
    // Gateway documentation specifies: "amount in cents, no decimal points"
    // Gateway validation enforces: "Min 100.00, Max 50000.00"
    // For INR ₹100, amount in cents = 10000
    const inrAmount = rawAmount ? (Number(amount) / 100) : Number(amount);
    const amountInCents = rawAmount ? Math.round(Number(amount)) : Math.round(inrAmount * 100);

    if (inrAmount < 100 || inrAmount > 50000) {
      return res.status(400).json({
        success: false,
        msg: `Amount must be between ₹100.00 and ₹50,000.00 (Current: ₹${inrAmount.toFixed(2)})`
      });
    }

    const outOrderNo = (customOrderNo && customOrderNo.trim().length > 0)
      ? customOrderNo.trim()
      : `ORD${Date.now()}${Math.floor(1000 + Math.random() * 9000)}`;

    const timestamp = Date.now();

    // Prepare request payload for Gateway
    const payloadParams = {
      merchantId: String(CONFIG.merchantId),
      outOrderNo: String(outOrderNo),
      amount: Number(amountInCents),
      timestamp: Number(timestamp)
    };

    if (notifyUrl && notifyUrl.trim()) {
      payloadParams.notifyUrl = notifyUrl.trim();
    }
    if (returnUrl && returnUrl.trim()) {
      payloadParams.returnUrl = returnUrl.trim();
    }

    // Generate HMAC-SHA256 signature
    const { signature, signString } = generateSignature(payloadParams, CONFIG.merchantKey);
    const finalPayload = {
      ...payloadParams,
      sign: signature
    };

    const targetUrl = `${CONFIG.gatewayUrl}/api/v1/openapi/payin/create`;

    console.log(`[PAYIN] Initiating Order: ${outOrderNo} | Amount: ₹${inrAmount} (${amountInCents} cents)`);
    console.log(`[PAYIN] Sign String: ${signString}`);
    console.log(`[PAYIN] Signature: ${signature}`);

    // Call payment gateway API
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8'
      },
      body: JSON.stringify(finalPayload)
    });

    const result = await response.json().catch(err => {
      throw new Error(`Failed to parse gateway response: ${err.message}`);
    });

    console.log('[PAYIN] Gateway Response:', JSON.stringify(result));

    if (result && result.code === 200 && result.data) {
      const data = result.data;
      let qrCodeDataUrl = null;

      // Generate QR Code if upiLink is present
      if (data.upiLink) {
        try {
          qrCodeDataUrl = await QRCode.toDataURL(data.upiLink, {
            errorCorrectionLevel: 'M',
            margin: 2,
            scale: 7,
            color: {
              dark: '#0f172a',
              light: '#ffffff'
            }
          });
        } catch (qrErr) {
          console.warn('[QR] Failed to generate QR:', qrErr.message);
        }
      }

      const orderRecord = {
        outOrderNo,
        merchantId: CONFIG.merchantId,
        inrAmount,
        amountInCents,
        payUrl: data.payUrl,
        upi: data.upi,
        upiLink: data.upiLink,
        qrCodeDataUrl,
        createTime: data.createTime || timestamp,
        status: 'PENDING',
        customerNote,
        createdAt: new Date().toISOString()
      };

      ordersDb.set(outOrderNo, orderRecord);

      return res.json({
        success: true,
        msg: 'Payment order created successfully',
        data: {
          ...orderRecord,
          signString,
          signature
        }
      });
    } else {
      return res.status(400).json({
        success: false,
        msg: result.msg || 'Payment gateway returned an error.',
        gatewayResponse: result,
        debug: {
          signString,
          signature
        }
      });
    }
  } catch (err) {
    console.error('[PAYIN ERROR]:', err);
    return res.status(500).json({
      success: false,
      msg: `Internal server error: ${err.message}`
    });
  }
});

// -------------------------------------------------------------
// API: Get Recent Orders
// -------------------------------------------------------------
app.get('/api/orders', (req, res) => {
  const orders = Array.from(ordersDb.values()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({
    success: true,
    orders: orders.slice(0, 50)
  });
});

// -------------------------------------------------------------
// API: Get Order Status by ID
// -------------------------------------------------------------
app.get('/api/orders/:outOrderNo', (req, res) => {
  const { outOrderNo } = req.params;
  const order = ordersDb.get(outOrderNo);
  if (!order) {
    return res.status(404).json({ success: false, msg: 'Order not found' });
  }
  res.json({ success: true, order });
});

// -------------------------------------------------------------
// API: Submit UTR Reference Number
// -------------------------------------------------------------
app.post('/api/orders/utr', async (req, res) => {
  const { outOrderNo, utr } = req.body;
  if (!outOrderNo || !utr || !/^\d{12}$/.test(utr)) {
    return res.status(400).json({ success: false, msg: 'Invalid 12-digit UTR number' });
  }

  // Update order in memory
  if (ordersDb.has(outOrderNo)) {
    const order = ordersDb.get(outOrderNo);
    order.status = 'PAID';
    order.utr = utr;
    order.paidAt = new Date().toISOString();
    ordersDb.set(outOrderNo, order);
  }

  // Forward to gateway desk saveUtr endpoint
  try {
    fetch('https://desk.talkpayapp.com/api/upi/saveUtr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ utr, outOrderNo })
    }).catch(() => {});
  } catch (e) {}

  res.json({ success: true, msg: 'UTR submitted successfully. Payment confirmed!' });
});

// -------------------------------------------------------------
// API: Webhook Callback Receiver
// -------------------------------------------------------------
app.all('/api/callback', (req, res) => {
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const payload = req.method === 'POST' ? req.body : req.query;

  console.log(`[CALLBACK] Received from ${clientIp}:`, JSON.stringify(payload));

  const logEntry = {
    receivedAt: new Date().toISOString(),
    clientIp,
    method: req.method,
    headers: req.headers,
    payload
  };

  callbackLogs.unshift(logEntry);
  if (callbackLogs.length > 50) callbackLogs.pop();

  // Validate incoming signature if present
  if (payload && payload.sign) {
    const isSignValid = verifySignature(payload, CONFIG.merchantKey, payload.sign);
    logEntry.signatureValid = isSignValid;

    if (isSignValid && payload.outOrderNo && ordersDb.has(payload.outOrderNo)) {
      const order = ordersDb.get(payload.outOrderNo);
      // Status code 1 or status "SUCCESS"
      if (payload.status === 1 || payload.status === 'SUCCESS' || payload.code === 200) {
        order.status = 'PAID';
        order.paidAt = new Date().toISOString();
        if (payload.utr) order.utr = payload.utr;
        ordersDb.set(payload.outOrderNo, order);
      }
    }
  }

  // Gateway typically expects 'success' string or 200 JSON
  res.send('success');
});

// -------------------------------------------------------------
// API: Get Callback Logs for Inspection
// -------------------------------------------------------------
app.get('/api/callbacks', (req, res) => {
  res.json({
    success: true,
    logs: callbackLogs
  });
});

// -------------------------------------------------------------
// Helper: Fallback routes for SPA / multi-page
// -------------------------------------------------------------
app.get('/pay', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pay.html'));
});

app.get('/success', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'success.html'));
});

app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(` SolidPay Payment Gateway Server is Running!`);
  console.log(` URL: http://localhost:${PORT}`);
  console.log(` Merchant ID: ${CONFIG.merchantId}`);
  console.log(` Gateway Target: ${CONFIG.gatewayUrl}`);
  console.log(` Callback IP Whitelist: ${CONFIG.callbackIp}`);
  console.log(`=======================================================`);
});
