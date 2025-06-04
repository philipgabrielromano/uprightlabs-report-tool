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

// ✅ NEW: Checkbox state file
const DATA_PATH = path.join(__dirname, 'data.json');
if (!fs.existsSync(DATA_PATH)) {
  fs.writeFileSync(DATA_PATH, JSON.stringify({ checked: false }));
}

// ✅ NEW: Get checkbox state
app.get('/api/checkbox-state', (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_PATH));
    res.json({ checked: data.checked });
  } catch (err) {
    console.error('Error reading checkbox state:', err);
    res.status(500).json({ checked: false });
  }
});

// ✅ NEW: Save checkbox state
app.post('/api/checkbox-state', (req, res) => {
  try {
    fs.writeFileSync(DATA_PATH, JSON.stringify({ checked: req.body.checked }));
    res.json({ success: true });
  } catch (err) {
    console.error('Error writing checkbox state:', err);
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

    const buyerMap = {};
    paidOrders.forEach(order => {
      if (order.channel_buyer_id) {
        buyerMap[order.channel_buyer_id] = {
          shipping_contact: order.shipping_contact || '',
          shipping_city: order.shipping_city || ''
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

      return {
        product_sku: entry.product_sku,
        order_items_count: entry.order_items.length,
        ebay_count: entry.ebay.length,
        shopgoodwill_count: entry.shopgoodwill.length,
        shipping_method: firstOrder.order_shipping_method || '',
        inventory_location: firstOrder.inventory_location || '',
        product_title: firstOrder.product_title || '',
        channel_buyer_id: firstOrder.channel_buyer_id || '',
        shipping_contact: buyerInfo.shipping_contact || '',
        shipping_city: buyerInfo.shipping_city || '',
        order_items_json: JSON.stringify(entry.order_items),
        order_paid_at: firstOrder.order_paid_at || '',
        ebay_json: JSON.stringify(entry.ebay),
        shopgoodwill_json: JSON.stringify(entry.shopgoodwill)
      };
    });

    res.json(flat);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to export data' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
