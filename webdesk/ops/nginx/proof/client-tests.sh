#!/bin/sh
# WSK-63a proof matrix. Runs inside the nginx container (shares Caddy's netns; `api` is the echo upstream).
# Prints real curl output for every row and a PASS/FAIL verdict; exits non-zero on any FAIL.
SECRET="$WEBDESK_CONTROL_GATE_SECRET"
CTL="https://control.webdesk.internal:9443"
TLS="--resolve control.webdesk.internal:9443:172.17.0.1 --cacert /certs/ca-cert.pem"
FAIL=0
hits() { curl -s http://api:3000/__hits | sed 's/[^0-9]//g'; }
verdict() { # name condition(0=ok)
  if [ "$2" -eq 0 ]; then echo "  => PASS  $1"; else echo "  => FAIL  $1"; FAIL=1; fi
}
fp() { openssl x509 -in "$1" -noout -fingerprint -sha256 | sed 's/.*=//'; }
b64() { base64 -w0 "$1"; }
row() { echo; echo "### $*"; }

REAL_FP=$(fp /certs/client.crt); EVIL_FP=$(fp /certs/evilclient.crt)
echo "real client fp : $REAL_FP"
echo "evil client fp : $EVIL_FP"

row "T1  no client cert -> refused by nginx, upstream never reached"
H0=$(hits)
OUT=$(curl -s -o /dev/null -w 'http=%{http_code}' $TLS $CTL/control/v1/tenants; echo " curl_exit=$?")
echo "$OUT"; H1=$(hits); echo "upstream hits before=$H0 after=$H1"
echo "$OUT" | grep -q 'http=400'; A=$?; [ "$H0" = "$H1" ]; B=$?; verdict "T1 no cert refused, 0 upstream hits" $((A+B))

row "T2  cert from ANOTHER CA (same CN) -> refused, upstream never reached"
H0=$(hits)
OUT=$(curl -s -o /dev/null -w 'http=%{http_code}' $TLS --cert /certs/evilclient.crt --key /certs/evilclient.key $CTL/control/v1/tenants; echo " curl_exit=$?")
echo "$OUT"; H1=$(hits); echo "upstream hits before=$H0 after=$H1"
echo "$OUT" | grep -qE 'http=400|curl_exit=(35|56)'; A=$?; [ "$H0" = "$H1" ]; B=$?; verdict "T2 foreign-CA cert refused, 0 upstream hits" $((A+B))

row "T3  valid cert -> 200; upstream gets the VERIFIED cert; Layer-1 verifier accepts; gate header not forwarded to api"
BODY=$(curl -s $TLS --cert /certs/client.crt --key /certs/client.key $CTL/control/v1/tenants)
echo "$BODY"
echo "$BODY" | grep -q "\"fingerprint256\":\"$REAL_FP\""; A=$?
echo "$BODY" | grep -q '"verified":true'; B=$?
echo "$BODY" | grep -q '"controlGateHeaderPresent":false'; C=$?
verdict "T3 verified cert delivered, layer1 verified, gate stripped before api" $((A+B+C))

row "T4  valid cert + FORGED inbound x-webdesk-mtls-cert-pem (evil cert) -> upstream receives the VERIFIED cert"
FORGED=$(b64 /certs/evilclient.crt)
BODY=$(curl -s $TLS --cert /certs/client.crt --key /certs/client.key -H "X-Webdesk-Mtls-Cert-Pem: $FORGED" $CTL/control/v1/tenants)
echo "$BODY"
echo "$BODY" | grep -q "\"fingerprint256\":\"$REAL_FP\""; A=$?
echo "$BODY" | grep -q "$EVIL_FP"; B=$?; [ $B -ne 0 ]; B=$?
verdict "T4 forged header replaced by the verified cert" $((A+B))

row "T4b valid cert + forged header + forged GATE header -> still the verified cert, request routed on nginx's own gate"
BODY=$(curl -s $TLS --cert /certs/client.crt --key /certs/client.key -H "X-Webdesk-Mtls-Cert-Pem: $FORGED" -H "X-Webdesk-Control-Gate: wrong" $CTL/control/v1/tenants)
echo "$BODY"
echo "$BODY" | grep -q "\"fingerprint256\":\"$REAL_FP\""; verdict "T4b" $?

row "T5  valid chain but wrong CN (some-other-service) -> nginx passes it, Layer 1 in the api refuses it (defence in depth)"
BODY=$(curl -s $TLS --cert /certs/wrongcn.crt --key /certs/wrongcn.key $CTL/control/v1/tenants)
echo "$BODY"
echo "$BODY" | grep -q '"verified":false'; verdict "T5 wrong CN rejected by Layer 1" $?

row "T6  control vhost serves nothing but /control/"
OUT=$(curl -s -o /dev/null -w 'http=%{http_code}' $TLS --cert /certs/client.crt --key /certs/client.key $CTL/v1/t/x/content)
echo "$OUT"; echo "$OUT" | grep -q 'http=404'; verdict "T6 /v1 on the control vhost is 404" $?

row "T7  Caddy directly: /control/* WITHOUT gate -> 404, upstream never reached"
H0=$(hits)
OUT=$(curl -s -o /dev/null -w 'http=%{http_code}' http://127.0.0.1:80/control/v1/tenants); echo "no gate:    $OUT"
OUT2=$(curl -s -o /dev/null -w 'http=%{http_code}' -H "X-Webdesk-Control-Gate: wrong" http://127.0.0.1:80/control/v1/tenants); echo "wrong gate: $OUT2"
H1=$(hits); echo "upstream hits before=$H0 after=$H1"
[ "$OUT" = "http=404" ] && [ "$OUT2" = "http=404" ] && [ "$H0" = "$H1" ]; verdict "T7 gate absent/wrong => 404, 0 hits" $?

row "T7b NEGATIVE CONTROL: the same request WITH the right gate header reaches the upstream"
OUT=$(curl -s -w ' http=%{http_code}' -H "X-Webdesk-Control-Gate: $SECRET" -H "X-Webdesk-Mtls-Cert-Pem: x" http://127.0.0.1:80/control/v1/tenants); echo "$OUT"
echo "$OUT" | grep -q 'http=200'; A=$?; echo "$OUT" | grep -q '"controlGateHeaderPresent":false'; B=$?
verdict "T7b right gate => 200 (and gate stripped before api)" $((A+B))

row "T8  PUBLIC vhost (api.gaiada.online shape, 127.0.0.1:8081): /control/* is 404 with or without headers, even the CORRECT gate"
H0=$(hits)
O1=$(curl -s -o /dev/null -w 'http=%{http_code}' http://127.0.0.1:8081/control/v1/tenants); echo "no headers:                $O1"
O2=$(curl -s -o /dev/null -w 'http=%{http_code}' -H "X-Webdesk-Control-Gate: wrong" http://127.0.0.1:8081/control/v1/tenants); echo "wrong gate:                $O2"
O3=$(curl -s -o /dev/null -w 'http=%{http_code}' -H "X-Webdesk-Control-Gate: $SECRET" -H "X-Webdesk-Mtls-Cert-Pem: $FORGED" http://127.0.0.1:8081/control/v1/tenants); echo "CORRECT gate + forged cert: $O3"
H1=$(hits); echo "upstream hits before=$H0 after=$H1"
[ "$O1" = "http=404" ] && [ "$O2" = "http=404" ] && [ "$O3" = "http=404" ] && [ "$H0" = "$H1" ]; verdict "T8 public /control/* is 404, 0 hits" $?

row "T9  public routes strip both headers (via nginx public vhost AND via Caddy directly)"
for P in v1/t/x/content forms/x media/x; do
  B1=$(curl -s -H "X-Webdesk-Control-Gate: $SECRET" -H "X-Webdesk-Mtls-Cert-Pem: $FORGED" "http://127.0.0.1:8081/$P")
  B2=$(curl -s -H "X-Webdesk-Control-Gate: $SECRET" -H "X-Webdesk-Mtls-Cert-Pem: $FORGED" "http://127.0.0.1:80/$P")
  echo "/$P via nginx-public: $B1"; echo "/$P via caddy       : $B2"
  echo "$B1" | grep -q '"mtlsCertHeaderPresent":false'; A=$?; echo "$B1" | grep -q '"controlGateHeaderPresent":false'; B=$?
  echo "$B2" | grep -q '"mtlsCertHeaderPresent":false'; C=$?; echo "$B2" | grep -q '"controlGateHeaderPresent":false'; D=$?
  verdict "T9 /$P both headers stripped on both paths" $((A+B+C+D))
done

echo; echo "RESULT: $([ $FAIL -eq 0 ] && echo ALL PASS || echo FAILURES)"
exit $FAIL
