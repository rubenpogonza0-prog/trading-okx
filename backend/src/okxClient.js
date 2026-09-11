import crypto from "node:crypto";
import fetch from "node-fetch";

const BASE_URL = "https://www.okx.com";

function sign(timestamp, method, requestPath, body, secret) {
  const prehash = timestamp + method + requestPath + body;
  return crypto.createHmac("sha256", secret).update(prehash).digest("base64");
}

export function createOkxClient({ apiKey, apiSecret, passphrase, demo }) {
  if (!apiKey || !apiSecret || !passphrase) {
    throw new Error(
      "Missing OKX credentials. Set OKX_API_KEY, OKX_API_SECRET and OKX_API_PASSPHRASE."
    );
  }

  async function request(method, path, { query, body } = {}) {
    const qs = query
      ? "?" +
        new URLSearchParams(
          Object.entries(query).filter(([, v]) => v !== undefined && v !== "")
        ).toString()
      : "";
    const requestPath = path + qs;
    const bodyStr = body ? JSON.stringify(body) : "";
    const timestamp = new Date().toISOString();
    const signature = sign(timestamp, method, requestPath, bodyStr, apiSecret);

    const headers = {
      "OK-ACCESS-KEY": apiKey,
      "OK-ACCESS-SIGN": signature,
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PASSPHRASE": passphrase,
      "Content-Type": "application/json",
    };
    if (demo) headers["x-simulated-trading"] = "1";

    const res = await fetch(BASE_URL + requestPath, {
      method,
      headers,
      body: bodyStr || undefined,
    });

    const json = await res.json();
    if (json.code !== "0") {
      const err = new Error(json.msg || "OKX API error");
      err.okxCode = json.code;
      err.okxData = json.data;
      throw err;
    }
    return json.data;
  }

  return {
    get: (path, query) => request("GET", path, { query }),
  };
}

export function okxClientFromEnv() {
  return createOkxClient({
    apiKey: process.env.OKX_API_KEY,
    apiSecret: process.env.OKX_API_SECRET,
    passphrase: process.env.OKX_API_PASSPHRASE,
    demo: process.env.OKX_DEMO === "1",
  });
}
