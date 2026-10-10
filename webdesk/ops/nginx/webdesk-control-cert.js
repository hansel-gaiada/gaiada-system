// WSK-63a - njs helper for control.webdesk.internal.conf.
//
// WHY THIS EXISTS: webdesk/api's Layer 1 (auth/mtls-verifier.ts) reads `x-webdesk-mtls-cert-pem` and
// base64-DECODES it to a PEM. nginx has no base64 primitive; `$ssl_client_raw_cert` is a PEM whose
// continuation lines are joined with "\n\t" (built for header folding). This returns
// base64(PEM with the tabs removed), which is exactly what the api decodes.
//
// It returns "" when the connection has no verified client cert. nginx omits a proxied header whose
// value is empty, so a vhost bug can never turn into a forged or blank-but-present header.
//
// Installed to /etc/nginx/njs/webdesk-control-cert.js; needs the libnginx-mod-http-js package
// (njs 0.7.9 on gda-aicenter's Debian 12 nginx 1.22.1).
function certB64(r) {
    if (r.variables.ssl_client_verify !== 'SUCCESS') {
        return '';
    }
    var pem = r.variables.ssl_client_raw_cert;
    if (!pem) {
        return '';
    }
    pem = pem.replace(/\t/g, '');
    return Buffer.from(pem).toString('base64');
}

export default { certB64 };
