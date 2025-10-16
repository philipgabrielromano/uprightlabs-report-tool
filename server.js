const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs'); // ✅ NEW
require('dotenv').config();

const app = express();
const PORT = 3000;
const API_BASE = 'https://app.uprightlabs.com/api/reports';

app.use(express.static('public'));
app.use(express.json()); // ✅ NEW

// ---------- Helpers (NEW) ----------
/**
 * Prefer upstream flat fields, then nested shipping, then reasonable fallbacks.
 * Centralize logic so if Upright changes payloads again, you only tweak here.
 */
function getShippingContact(src) {
  return (
    src?.shipping_contact ??          // legacy flat field
    src?.shipping?.contact ??         // nested contact
    src?.shipping?.name ??            // nested name
    src?.recipient_name ??            // alternate flat recipient field
    src?.buyer?.name ??               // some payloads include buyer object
    src?.customer_name ??             // occasional alias
    src?.shipping_name ??             // another alias seen in some APIs
    ''                                // final fallback
  );
}

function getShippingCity(src) {
  return (
    src?.shipping_city ??
    src?.shipping?.city ??
    ''
  );
}

// ✅ NEW: Checkbox state file
const DATA_PATH = path.join(__dirname, 'data.json');
if (!fs.existsSync(DATA_PATH)) {
  fs.writeFileSync(DATA_PATH, JSON.stringify({ checked: false }));
}

// Load all checkbox states
app.get("/api/checkbox-state", (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_PATH));
    res.json(data.checked || {});
  } catch (err) {
    console.error("Error reading checkbox state:", err);
    res.status(500).json({});
  }
});

// Update one checkbox state (expects { sku: "SKU12345", checked: true/false })
app.post("/api/checkbox-state", (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_PATH));
    data.checked = data.checked || {};
    data.checked[req.body.sku] = req.body.checked;
    fs.writeFileSync(DATA_PATH, JSON.stringify(data));
    res.json({ success: true });
  } catch (err) {
    console.error("Error writing checkbox state:", err);
    res.status(500).json({ success: false });
  }
});

function getUrl(endpoint, start, end) {
  return `${API_BASE}${endpoint}?time_start=${start}&time_end=${end}`;
}

async function fetchAndForward(url, res) {
  try {
    const response = await fetch(url, {
      headers: { 'X-Authorization': process.env.UPRIGHT_API_KEY }
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'API fetch failed' });
  }
}

app.get('/api/order_items', (req, res) => {
  const { time_start, time_end } = req.query;
  fetchAndForward(getUrl('/order_items', time_start, time_end), res);
});

app.get('/api/listings/ebay', (req, res) => {
  const { time_start, time_end } = req.query;
  fetchAndForward(getUrl('/listings/ebay', time_start, time_end), res);
});

app.get('/api/listings/shopgoodwill', (req, res) => {
  const { time_start, time_end } = req.query;
  fetchAndForward(getUrl('/listings/shopgoodwill', time_start, time_end), res);
});

app.get('/api/export', async (req, res) => {
  const { time_start, time_end, shipping_method } = req.query;
  try {
    const [orderResponse, ebay, sg, paidOrdersResponse] = await Promise.all([
      fetch(getUrl('/order_items', time_start, time_end), {
        headers: { 'X-Authorization': process.env.UPRIGHT_API_KEY }
      }).then(r => r.json()),
      fetch(getUrl('/listings/ebay', time_start, time_end), {
        headers: { 'X-Authorization': process.env.UPRIGHT_API_KEY }
      }).then(r => r.json()),
      fetch(getUrl('/listings/shopgoodwill', time_start, time_end), {
        headers: { 'X-Authorization': process.env.UPRIGHT_API_KEY }
      }).then(r => r.json()),
      fetch(getUrl('/paid_orders', time_start, time_end), {
        headers: { 'X-Authorization': process.env.UPRIGHT_API_KEY }
      }).then(r => r.json())
    ]);

    const orders = Array.isArray(orderResponse) ? orderResponse : orderResponse.data || [];
    const paidOrders = Array.isArray(paidOrdersResponse) ? paidOrdersResponse : paidOrdersResponse.data || [];

    // Build buyer map from paid orders, but use robust fallbacks
    const buyerMap = {};
    paidOrders.forEach(po => {
      if (po.channel_buyer_id) {
        buyerMap[po.channel_buyer_id] = {
          shipping_contact: getShippingContact(po),
          shipping_city: getShippingCity(po)
        };
      }
    });

    const merged = {};

    function add(group, type) {
      if (!Array.isArray(group)) {
        console.warn(`Expected an array for ${type}, got:`, group);
        return;
      }
      for (const row of group) {
        if (type === 'order_items' && shipping_method && row.order_shipping_method !== shipping_method) continue;
        const sku = row.product_sku || 'UNKNOWN';
        if (!merged[sku]) merged[sku] = { product_sku: sku, order_items: [], ebay: [], shopgoodwill: [] };
        merged[sku][type].push(row);
      }
    }

    add(orders, 'order_items');
    add(ebay, 'ebay');
    add(sg, 'shopgoodwill');

    const flat = Object.values(merged).map(entry => {
      const firstOrder = entry.order_items[0] || {};
      const buyerInfo = buyerMap[firstOrder.channel_buyer_id] || {};

      // Compute normalized shipping contact/city with layered fallbacks:
      // 1) buyerMap from paid_orders (preferred if present)
      // 2) fields directly on firstOrder (handles cases where buyerMap is missing)
      const normalizedShippingContact =
        buyerInfo.shipping_contact || getShippingContact(firstOrder);

      const normalizedShippingCity =
        buyerInfo.shipping_city || getShippingCity(firstOrder);

      return {
        product_sku: entry.product_sku,
        order_items_count: entry.order_items.length,
        ebay_count: entry.ebay.length,
        shopgoodwill_count: entry.shopgoodwill.length,
        shipping_method: firstOrder.order_shipping_method || '',
        inventory_location: firstOrder.inventory_location || '',
        product_title: firstOrder.product_title || '',
        channel_buyer_id: firstOrder.channel_buyer_id || '',
        // ✅ Use normalized values so "Shipping Contact" reliably populates
        shipping_contact: normalizedShippingContact,
        shipping_city: normalizedShippingCity,
        order_items_json: JSON.stringify(entry.order_items),
        order_paid_at: firstOrder.order_paid_at || '',
        ebay_json: JSON.stringify(entry.ebay),
        shopgoodwill_json: JSON.stringify(entry.shopgoodwill)
      };
    });

    // Optional: one-line debug for the first row to verify fields during testing
    if (flat.length) {
      console.log('shipping debug:', {
        fromPaidOrders_contact: buyerMap[flat[0].channel_buyer_id]?.shipping_contact,
        fromOrder_fallback_contact: getShippingContact((merged[flat[0].product_sku] || {}).order_items?.[0]),
        final_contact: flat[0].shipping_contact
      });
    }

    res.json(flat);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to export data' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
