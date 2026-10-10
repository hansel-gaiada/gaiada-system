#!/bin/sh
# WSK-63a proof: THROWAWAY CAs and certs (ECDSA P-256, like the estate CA). Never use these anywhere real.
set -eu
cd /certs
mkca() { # name
  openssl ecparam -name prime256v1 -genkey -noout -out "$1-key.pem"
  openssl req -x509 -new -key "$1-key.pem" -sha256 -days 30 -subj "/CN=$2" \
    -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign,digitalSignature -out "$1-cert.pem"
}
issue() { # ca cn out eku [san]
  openssl ecparam -name prime256v1 -genkey -noout -out "$3.key"
  openssl req -new -key "$3.key" -subj "/CN=$2" -out "$3.csr"
  { echo "keyUsage=critical,digitalSignature"; echo "extendedKeyUsage=$4"; [ -n "${5:-}" ] && echo "subjectAltName=$5"; } > "$3.ext"
  openssl x509 -req -in "$3.csr" -CA "$1-cert.pem" -CAkey "$1-key.pem" -CAcreateserial -days 30 -sha256 -extfile "$3.ext" -out "$3.crt" 2>/dev/null
}
mkca ca gaiada-internal-ca
mkca evil evil-ca
issue ca control.webdesk.internal server serverAuth DNS:control.webdesk.internal
issue ca platform-nest-webdesk client clientAuth
issue ca some-other-service wrongcn clientAuth
issue evil platform-nest-webdesk evilclient clientAuth
cp server.key server.key.tmp && mv server.key.tmp server.key
chmod 644 *.pem *.crt *.key
ls -1 /certs | tr '\n' ' '; echo
