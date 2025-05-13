const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = 3000;
const API_BASE = 'https://app.uprightlabs.com/api/reports';

app.use(express.static('public'));

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
  const endpoints = [
    fetch(getUrl('/order_items', time_start, time_end), {
      headers: { 'X-Authorization': process.env.UPRIGHT_API_KEY }
    }).then(r => r.json()),
    fetch(getUrl('/listings/ebay', time_start, time_end), {
      headers: { 'X-Authorization': process.env.UPRIGHT_API_KEY }
    }).then(r => r.json()),
    fetch(getUrl('/listings/shopgoodwill', time_start, time_end), {
      headers: { 'X-Authorization': process.env.UPRIGHT_API_KEY }
    }).then(r => r.json())
  ];

  try {
    const [orders, ebay, sg] = await Promise.all(endpoints);
    const merged = {};

    function add(group, type) {
  if (!Array.isArray(group)) {
    console.warn(`Expected an array for ${type}, got:`, group);
    return;
  }
  for (const row of group) {
    if (type === 'order_items' && shipping_method && row.shipping_method !== shipping_method) continue;
    const sku = row.product_sku || 'UNKNOWN';
    if (!merged[sku]) merged[sku] = { product_sku: sku, order_items: [], ebay: [], shopgoodwill: [] };
    merged[sku][type].push(row);
  }
};
        merged[sku][type].push(row);
      }
    }

    add(orders, 'order_items');
    add(ebay, 'ebay');
    add(sg, 'shopgoodwill');

    // Flatten for export: one row per product_sku
    const flat = Object.values(merged).map(entry => ({
      product_sku: entry.product_sku,
      order_items_count: entry.order_items.length,
      ebay_count: entry.ebay.length,
      shopgoodwill_count: entry.shopgoodwill.length,
      order_items_json: JSON.stringify(entry.order_items),
      ebay_json: JSON.stringify(entry.ebay),
      shopgoodwill_json: JSON.stringify(entry.shopgoodwill)
    }));

    res.json(flat);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to export data' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
