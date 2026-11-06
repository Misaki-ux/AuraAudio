const fs = require('node:fs');
const http = require('node:http');
const qrcode = require('qrcode-generator');

const [port, domain, httpsPort, accessKey, outputPath] = process.argv.slice(2);
if (!port || !domain || !httpsPort || !accessKey || !outputPath) {
    throw new Error('Usage: generate-autonomous-pairing-qr.js <api-port> <domain> <https-port> <access-key> <output-html>');
}

const request = http.request({
    hostname: '127.0.0.1',
    port: Number(port),
    path: '/api/mobile/pairing',
    method: 'POST',
    headers: {
        Host: `${domain}:${httpsPort}`,
        'X-Forwarded-Proto': 'https',
        'X-Aura-Access-Key': accessKey,
        'Content-Type': 'application/json',
        'Content-Length': 2,
        Connection: 'close'
    }
}, response => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => {
        let result;
        try {
            result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
            throw new Error(`Pairing endpoint returned invalid JSON (${response.statusCode}).`);
        }
        if (response.statusCode !== 201 || !result.pairUrl) {
            throw new Error(result.message || `Pairing request failed (${response.statusCode}).`);
        }
        const qr = qrcode(0, 'M');
        qr.addData(result.pairUrl);
        qr.make();
        const qrImage = Buffer.from(qr.createSvgTag(6, 4)).toString('base64');
        const expiresInSeconds = Number(result.expiresInSeconds) || 120;
        const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Pair AuraAudio Autonomous Client</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#090a0f;color:#f4f4f5;font:16px/1.5 system-ui,sans-serif}
main{width:min(100%,440px);padding:28px;border:1px solid #27272a;border-radius:22px;background:#111113;text-align:center;box-shadow:0 24px 80px #0008}
h1{margin:0;font-size:1.35rem}p{color:#a1a1aa}.qr{display:block;width:min(100%,300px);margin:22px auto;padding:12px;border-radius:14px;background:#fff}
a{color:#93c5fd;overflow-wrap:anywhere}.expiry{font-variant-numeric:tabular-nums;color:#fbbf24;font-weight:650}
.hint{font-size:.875rem}
</style>
</head>
<body>
<main>
<h1>Pair AuraAudio Autonomous Client</h1>
<p>Open your phone's camera and scan this QR code. It connects the phone to the autonomous client over HTTPS.</p>
<img class="qr" src="data:image/svg+xml;base64,${qrImage}" alt="One-time AuraAudio pairing QR code">
<p class="expiry">This code expires in <span id="countdown">${expiresInSeconds}</span> seconds or after it is used.</p>
<p class="hint">If scanning fails, open this link on the phone:<br><a href="${result.pairUrl}">${result.pairUrl}</a></p>
<p class="hint">Keep the AuraAudio server window running while pairing.</p>
</main>
<script>
let remaining=${expiresInSeconds};
const countdown=document.getElementById('countdown');
const timer=setInterval(()=>{remaining=Math.max(0,remaining-1);countdown.textContent=String(remaining);if(!remaining){clearInterval(timer);countdown.parentElement.textContent='This code has expired. Close this page and restart the launcher to create another.'}},1000);
</script>
</body>
</html>`;
        fs.writeFileSync(outputPath, page, { encoding: 'utf8', mode: 0o600 });
        process.stdout.write(`Pairing QR ready; scan it within ${Math.floor(result.expiresInSeconds / 60)} minutes.\n`);
    });
});

request.on('error', error => {
    console.error(`Could not create the pairing QR: ${error.message}`);
    process.exitCode = 1;
});
request.setTimeout(8000, () => request.destroy(new Error('Pairing request timed out.')));
request.end('{}');
