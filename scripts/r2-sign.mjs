/* r2-sign.mjs — ONE SigV4 signer for the R2 operator scripts.
 *
 * WHY THIS EXISTS. `showcase-update.mjs` and `archive-showcase.mjs` each carried a byte-identical
 * copy of this function (the second was written by copying the first on 9/3, and `find-twins`
 * caught it). Two copies of an authentication protocol is a bad kind of duplicate: a drift between
 * them does not fail loudly at the edit, it fails later as an opaque 403 from Cloudflare, on
 * whichever script was not updated — and a 403 in a publish path is exactly the failure that let a
 * client's map serve a stale copy for a week.
 *
 * Credentials are read from secrets/ by the caller and passed in, so this module holds no secret
 * and can be imported from anywhere.
 *
 *   import { makeSigner } from "./r2-sign.mjs";
 *   const signed = makeSigner({ endpoint: ENDPOINT, accessKey: AK, secretKey: SK, bucket: BUCKET });
 *   const { url, headers } = signed("PUT", "maps/x/index.html", null, body, { "content-type": "text/html" });
 */
import crypto from "node:crypto";

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const hmac = (k, s) => crypto.createHmac("sha256", k).update(s).digest();

export function makeSigner({ endpoint, accessKey, secretKey, bucket }) {
  if (!endpoint || !accessKey || !secretKey || !bucket) {
    throw new Error("makeSigner: endpoint, accessKey, secretKey and bucket are all required");
  }
  return function signed(method, key, query, body, extraHeaders) {
    const host = endpoint.replace("https://", "");
    const now = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
    const day = now.slice(0, 8);
    const bodyHash = sha(body || "");
    const hdrs = Object.assign({ host, "x-amz-content-sha256": bodyHash, "x-amz-date": now }, extraHeaders || {});
    const names = Object.keys(hdrs).map((h) => h.toLowerCase()).sort();
    const canonHdrs = names.map((h) => `${h}:${String(hdrs[h] ?? hdrs[Object.keys(hdrs).find((k) => k.toLowerCase() === h)]).trim()}\n`).join("");
    const qs = Object.keys(query || {}).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`).join("&");
    const canonPath = `/${bucket}/${key}`.split("/").map(encodeURIComponent).join("/").replace(/%2F/g, "/");
    const canon = `${method}\n${canonPath}\n${qs}\n${canonHdrs}\n${names.join(";")}\n${bodyHash}`;
    const scope = `${day}/auto/s3/aws4_request`;
    const toSign = `AWS4-HMAC-SHA256\n${now}\n${scope}\n${sha(canon)}`;
    const sig = crypto.createHmac("sha256", hmac(hmac(hmac(hmac("AWS4" + secretKey, day), "auto"), "s3"), "aws4_request")).update(toSign).digest("hex");
    const auth = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${names.join(";")}, Signature=${sig}`;
    const out = Object.assign({}, hdrs, { Authorization: auth });
    delete out.host;
    return { url: `${endpoint}/${bucket}/${key}${qs ? "?" + qs : ""}`, headers: out };
  };
}
