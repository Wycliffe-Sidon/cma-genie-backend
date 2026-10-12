// ============================================================
// CMA Genie — AI Backend v4.2
// Zillapi Real Comps + Free FX + Zestimate Anchoring
// ============================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const ZILLAPI_KEY = process.env.ZILLAPI_KEY;

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'openai/gpt-oss-120b';
const EXCHANGE_URL = 'https://open.er-api.com/v6/latest/USD';
const ZILLAPI_URL = 'https://api.zillapi.com/v1';

// ─── Middleware ─────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
  req.id = Math.random().toString(36).substring(2, 8);
  console.log(`[${new Date().toISOString()}] [${req.id}] ${req.method} ${req.path}`);
  next();
});

// ─── Exchange Rate (free, no key) ───────────────────────────
async function getExchangeRate(source, target) {
  if (source === target) return 1.0;
  try {
    const r = await axios.get(EXCHANGE_URL, { timeout: 10000 });
    const rates = r.data?.rates;
    if (!rates) throw new Error('No rates');
    const rate = rates[target] / (rates[source] || 1);
    console.log(`FX: 1 ${source} = ${rate.toFixed(4)} ${target}`);
    return rate;
  } catch (e) {
    console.error('FX error:', e.message);
    const fallbacks = {
      USD_KES: 130, USD_GBP: 0.79, USD_NGN: 1500, USD_ZAR: 18.5,
      USD_CAD: 1.36, USD_AUD: 1.52, USD_AED: 3.67,
    };
    return fallbacks[`${source}_${target}`] || 1.0;
  }
}

// ─── Zillapi Comps + Anchor ─────────────────────────────────
async function getComparableProperties(address, propertyType) {
  try {
    console.log('Zillapi: lookup:', address, '| type:', propertyType || 'unknown');

    const response = await axios.get(`${ZILLAPI_URL}/properties/by-address`, {
      params: { address: address },
      headers: {
        'Authorization': `Bearer ${ZILLAPI_KEY}`,
        'Accept': 'application/json',
      },
      timeout: 30000,
    });

    const subject = response.data?.data;
    if (!subject) {
      console.log('Zillapi: No subject data');
      return { comparables: [], anchor: null, source: 'Zillapi (No Data)' };
    }

    // ─── Extract the authoritative anchor ───────────────
    const zestimate = subject.zestimate || 0;
    const listedPrice = subject.price || subject.listingPrice?.amount || 0;
    const anchorValue = zestimate > 0 ? zestimate : listedPrice;
    const anchor = anchorValue > 0
      ? { zestimate: anchorValue, price: listedPrice || anchorValue }
      : null;

    console.log(`Zillapi: ${subject.formattedAddress}`);
    console.log(`Zillapi: Zestimate $${zestimate}, Listed $${listedPrice}`);

    // ─── Filter nearby homes ────────────────────────────
    const nearbyHomes = subject.nearbyHomes || [];
    console.log(`Zillapi: ${nearbyHomes.length} nearby homes`);

    const typeFilter = (propertyType || '').toLowerCase();
    const typeMap = {
      apartment: ['APARTMENT', 'CONDO'],
      house: ['SINGLE_FAMILY'],
      townhouse: ['TOWNHOUSE'],
      villa: ['SINGLE_FAMILY'],
      maisonette: ['SINGLE_FAMILY', 'CONDO'],
      land: ['LOT', 'LAND'],
      commercial: ['HOME_TYPE_UNKNOWN'],
    };
    const allowed = typeMap[typeFilter] || [];

    let filtered = nearbyHomes.filter((h) => h.price && h.price > 0);

    if (allowed.length > 0) {
      const matching = filtered.filter(
        (h) => h.homeType && allowed.includes(h.homeType.toUpperCase())
      );
      if (matching.length >= 2) filtered = matching;
    }

    const comparables = filtered.slice(0, 3).map((h) => {
      const a = h.address || {};
      const parts = [a.streetAddress, a.city, a.state].filter(Boolean);
      return {
        address: parts.join(', '),
        beds: h.bedrooms || 0,
        baths: h.bathrooms || 0,
        size: h.livingArea || h.livingAreaValue || 0,
        price: h.price,
        distance: 0.2,
        daysAgo: 30,
      };
    });

    console.log(`Zillapi: Returning ${comparables.length} comps`);
    return { comparables, anchor, source: 'Zillapi' };
  } catch (error) {
    console.error('Zillapi error:', error.message);
    if (error.response) {
      console.error('Zillapi status:', error.response.status);
      console.error('Zillapi body:', JSON.stringify(error.response.data).substring(0, 300));
    }
    return { comparables: [], anchor: null, source: 'Zillapi (Failed)' };
  }
}

// ─── Main CMA Endpoint ──────────────────────────────────────
app.post('/api/cma/generate', async (req, res) => {
  const { address, beds, baths, sqft, askingPrice, country, propertyType } = req.body;
  const reqId = req.id;

  const countries = {
    KE: { name: 'Kenya', currency: 'KES', symbol: 'KSh', unit: 'sqft', distance: 'km' },
    US: { name: 'United States', currency: 'USD', symbol: '$', unit: 'sqft', distance: 'miles' },
    GB: { name: 'United Kingdom', currency: 'GBP', symbol: '£', unit: 'sqft', distance: 'miles' },
    CA: { name: 'Canada', currency: 'CAD', symbol: 'C$', unit: 'sqft', distance: 'km' },
    AU: { name: 'Australia', currency: 'AUD', symbol: 'A$', unit: 'sqm', distance: 'km' },
    NG: { name: 'Nigeria', currency: 'NGN', symbol: '₦', unit: 'sqm', distance: 'km' },
    ZA: { name: 'South Africa', currency: 'ZAR', symbol: 'R', unit: 'sqm', distance: 'km' },
    AE: { name: 'United Arab Emirates', currency: 'AED', symbol: 'AED', unit: 'sqft', distance: 'km' },
  };
  const countryConfig = countries[country] || countries.US;
  const isUS = country === 'US';

  const type = (propertyType || 'house').toLowerCase();
  const typeLabel = {
    apartment: 'Apartment / Flat',
    house: 'House / Bungalow',
    townhouse: 'Townhouse / Terrace',
    villa: 'Villa / Mansion',
    maisonette: 'Maisonette',
    land: 'Land / Plot',
    commercial: 'Commercial Property',
  }[type] || 'Property';

  try {
    console.log(`[${reqId}] Generating: ${address} (${country}) | type: ${type}`);

    // 1. Fetch real comps + anchor (US only)
    let compsData = { comparables: [], anchor: null, source: 'skipped (non-US)' };
    if (isUS) {
      compsData = await getComparableProperties(address, type);
    }

    // 2. FX rate (non-US only)
    let exchangeRate = 1.0;
    if (!isUS) {
      exchangeRate = await getExchangeRate('USD', countryConfig.currency);
    }

    // 3. Build AI prompt — plain text, no markdown, no LaTeX
    const compsBlock = compsData.comparables.length > 0
      ? `REAL COMPARABLE PROPERTIES (use these exactly as-is):\n${JSON.stringify(compsData.comparables, null, 2)}`
      : `No real comparable data available. Generate 3 realistic comparables for the specific neighborhood.`;

    const anchorBlock = compsData.anchor
      ? `AUTHORITATIVE VALUE ANCHOR (from Zillow's Zestimate):
- Subject property Zestimate: ${compsData.anchor.zestimate}
- Subject property last listed price: ${compsData.anchor.price}
Your estimatedValue MUST be within ±5% of the Zestimate: ${Math.round(compsData.anchor.zestimate * 0.95)} to ${Math.round(compsData.anchor.zestimate * 1.05)}.`
      : `No authoritative anchor available. Base your estimate on the comparables.`;

    const systemPrompt = `You are a professional CMA (Comparative Market Analysis) report generator.

STRICT OUTPUT RULES:
1. Return ONLY valid JSON. No markdown, no code fences, no extra text.
2. All monetary values MUST be plain integers in USD (no symbols, no commas inside numbers).
3. In narrative, marketInsights, and pricingStrategy:
   - Write PLAIN ENGLISH TEXT only.
   - NEVER use LaTeX or math delimiters: no \\( \\) \\[ \\] \\$
   - NEVER use markdown: no **bold**, *italic*, # headers, or - bullet points.
   - Write dollar amounts as plain text: "$845,000" (with the $ character, no escape).
   - Use commas in numbers when writing them in prose ("845,000"), but plain integers in JSON fields.
4. Reference the specific neighborhood in your narrative.
5. Use the AUTHORITATIVE VALUE ANCHOR when provided — the estimated value must respect it.
6. The property type is ${typeLabel}. Value it as such (land ≠ house, apartment ≠ villa).

JSON STRUCTURE:
{
  "estimatedValue": <int>,
  "lowRange": <int>,
  "highRange": <int>,
  "confidence": "<Low|Medium|High>",
  "narrative": "<2-3 sentences plain text>",
  "comparables": [{"address":"<str>","beds":<int>,"baths":<int>,"size":<int>,"price":<int>,"distance":<float>,"daysAgo":<int>}],
  "marketInsights": ["<plain text>","<plain text>","<plain text>"],
  "pricingStrategy": "<1-2 sentences plain text>"
}`;

    const userPrompt = `Generate a CMA report.

SUBJECT PROPERTY:
- Address: ${address}
- Country: ${countryConfig.name}
- Property Type: ${typeLabel}
- Beds: ${beds}, Baths: ${baths}, Size: ${sqft || 'unknown'} ${countryConfig.unit}
- Asking Price: ${askingPrice ? '$' + askingPrice : 'not provided'} (USD)

${anchorBlock}

${compsBlock}

Return the JSON now. Plain text only in prose fields — no markdown, no LaTeX, no escaped symbols.`;

    // 4. Call Groq
    const aiResp = await axios.post(
      GROQ_URL,
      {
        model: GROQ_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.7,
        max_tokens: 2000,
      },
      {
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    let aiData;
    try {
      aiData = JSON.parse(aiResp.data.choices[0].message.content);
    } catch (e) {
      console.error(`[${reqId}] JSON parse failed`);
      throw new Error('AI returned invalid JSON');
    }

    // 5. Anchor the estimate — if Zillapi gave a Zestimate, clamp to ±5%
    if (compsData.anchor && compsData.anchor.zestimate > 0) {
      const anchor = compsData.anchor.zestimate;
      const low = Math.round(anchor * 0.95);
      const high = Math.round(anchor * 1.05);
      if (!aiData.estimatedValue ||
          aiData.estimatedValue < low ||
          aiData.estimatedValue > high) {
        console.log(`[${reqId}] Clamping AI value ${aiData.estimatedValue} to anchor range [${low}, ${high}]`);
        aiData.estimatedValue = anchor;
      }
    }

    // 6. Override comps with real Zillapi data
    if (compsData.comparables.length > 0) {
      aiData.comparables = compsData.comparables;
    }

    // 7. Convert to target currency
    const convert = (v) => Math.round((v || 0) * exchangeRate);

    const convertedData = {
      estimatedValue: convert(aiData.estimatedValue),
      lowRange: convert(aiData.lowRange || aiData.estimatedValue * 0.95),
      highRange: convert(aiData.highRange || aiData.estimatedValue * 1.05),
      pricePerUnit: sqft ? Math.round((aiData.estimatedValue / sqft) * exchangeRate) : 0,
      confidence: aiData.confidence || 'Medium',
      comparables: (aiData.comparables || []).map((c) => ({
        address: c.address || 'Unknown',
        beds: c.beds || 0,
        baths: c.baths || 0,
        size: c.size || c.sqft || 0,
        price: convert(c.price),
        distance: c.distance || 0.2,
        daysAgo: c.daysAgo || 30,
      })),
      narrative: sanitize(aiData.narrative || ''),
      pricingStrategy: sanitize(aiData.pricingStrategy || ''),
      marketInsights: Array.isArray(aiData.marketInsights)
        ? aiData.marketInsights.map(sanitize)
        : [],
    };

    console.log(`[${reqId}] Done. ${convertedData.comparables.length} comps, FX=${exchangeRate}`);

    res.json({
      success: true,
      data: convertedData,
      country,
      currency: countryConfig.currency,
      currencySymbol: countryConfig.symbol,
      unit: countryConfig.unit,
      distanceUnit: countryConfig.distance,
      propertyType: type,
      exchangeRateUsed: exchangeRate,
      compsSource: compsData.source,
      anchored: !!compsData.anchor,
      model: GROQ_MODEL,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error(`[${reqId}] Fatal:`, error.message);
    if (error.response) {
      console.error(`[${reqId}] Response:`, JSON.stringify(error.response.data).substring(0, 400));
    }
    res.status(500).json({
      error: 'Failed to generate CMA report.',
      details: error.message,
      requestId: reqId,
    });
  }
});

// ─── Sanitize AI text (strip LaTeX/Markdown artifacts) ──────
function sanitize(text) {
  if (!text || typeof text !== 'string') return '';
  let s = text;

  // Remove LaTeX math delimiters: \( \) \[ \]
  s = s.replace(/\\\(|\\\)|\\\[|\\\]/g, '');

  // Unescape \$ \& \% \#
  s = s.replace(/\\\$/g, '$');
  s = s.replace(/\\&/g, '&');
  s = s.replace(/\\%/g, '%');
  s = s.replace(/\\#/g, '#');

  // Remove markdown bold/italic
  s = s.replace(/\*\*(.+?)\*\*/g, '$1');
  s = s.replace(/\*(.+?)\*/g, '$1');
  s = s.replace(/__(.+?)__/g, '$1');

  // Remove leading markdown headers
  s = s.replace(/^#+\s+/gm, '');

  // Remove leading bullet markers
  s = s.replace(/^\s*[-*+]\s+/gm, '');

  // Collapse multiple spaces/newlines
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/\n{3,}/g, '\n\n');

  return s.trim();
}

// ─── Health ─────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'CMA Genie Backend',
    version: '4.2.0',
    features: [
      'property-type',
      'real-comps-us',
      'zestimate-anchor',
      'ai-text-sanitization',
      'live-fx',
      'multi-country',
    ],
    sources: {
      comps: 'Zillapi (US)',
      exchange: 'open.er-api.com',
      ai: GROQ_MODEL,
    },
    time: new Date().toISOString(),
  });
});

// ─── Start ──────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('╔════════════════════════════════════════════╗');
  console.log('║   CMA Genie Backend v4.2                  ║');
  console.log('║   + Zestimate Anchoring                   ║');
  console.log('║   + AI Text Sanitization                  ║');
  console.log('╚════════════════════════════════════════════╝');
  console.log(`   Port:     ${PORT}`);
  console.log(`   AI:       ${GROQ_MODEL}`);
  console.log(`   Comps:    Zillapi (US only, type-aware)`);
  console.log(`   Exchange: open.er-api.com (no key)`);
  console.log(`   Groq:     ${GROQ_API_KEY ? '✓' : '✗ MISSING'}`);
  console.log(`   Zillapi:  ${ZILLAPI_KEY ? '✓' : '✗ MISSING'}`);
  console.log('');
});