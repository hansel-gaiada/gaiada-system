#!/usr/bin/env bash
# Entry point for every harness container. Role = $1. Everything here is throwaway test scaffolding.
set -euo pipefail

role="${1:?role}"

mkusers() {
  home="${1:-}"
  # Same uids in every container, so one volume is owned consistently.
  for pair in "a:2001:${PW_A:?}" "b:2002:${PW_B:?}"; do
    IFS=: read -r name uid pw <<<"$pair"
    getent group "$name" >/dev/null || groupadd -g "$uid" "$name"
    id "$name" >/dev/null 2>&1 || useradd -u "$uid" -g "$uid" -M -d "${home:-/$name}" -s /usr/sbin/nologin "$name"
    printf '%s:%s\n' "$name" "$pw" | chpasswd
  done
}

case "$role" in
  setup)
    umask 022
    find /pki -mindepth 1 -delete
    mkdir -p /pki/ssh /pki/ssh-rogue /pki/ftps /pki/ftps-rogue /pki/https
    ssh-keygen -q -t ed25519 -N '' -f /pki/ssh/ssh_host_ed25519_key
    ssh-keygen -q -t ed25519 -N '' -f /pki/ssh-rogue/ssh_host_ed25519_key
    ssh-keygen -q -t ed25519 -N '' -f /pki/client_key
    # A private CA signs the https certificate and the real ftps certificate.
    openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=p6e-harness-ca" \
      -keyout /pki/ca.key -out /pki/ca.crt 2>/dev/null
    leaf() { # name dir sans  [signed-by-ca]
      openssl req -newkey rsa:2048 -nodes -subj "/CN=$1" -keyout "$2/key.pem" -out "$2/req.csr" 2>/dev/null
      printf 'subjectAltName=%s\nbasicConstraints=CA:FALSE\n' "$3" >"$2/ext.cnf"
      if [ "${4:-}" = ca ]; then
        openssl x509 -req -in "$2/req.csr" -CA /pki/ca.crt -CAkey /pki/ca.key -CAcreateserial -days 2 \
          -extfile "$2/ext.cnf" -out "$2/cert.pem" 2>/dev/null
      else
        openssl x509 -req -in "$2/req.csr" -signkey "$2/key.pem" -days 2 -extfile "$2/ext.cnf" -out "$2/cert.pem" 2>/dev/null
      fi
    }
    leaf ftps /pki/ftps "DNS:ftps" ca
    leaf ftps /pki/ftps-rogue "DNS:ftps,DNS:ftps-rogue"          # self-signed, same name: a hijacker
    leaf site /pki/https "DNS:site-a,DNS:site-b" ca
    chmod 600 /pki/*/key.pem /pki/ssh/ssh_host_ed25519_key /pki/ssh-rogue/ssh_host_ed25519_key
    chmod 644 /pki/ca.crt /pki/client_key.pub /pki/*/cert.pem
    chmod 644 /pki/client_key   # the client container reads it; a throwaway key
    # Two principals, each with a base dir of its own. /data is root-owned (the chroot), /<user> is 0711
    # so the https server can traverse to the docroot while the OTHER principal cannot write.
    mkdir -p /data/a/site /data/b/site
    chown 2001:2001 /data/a /data/a/site; chown 2002:2002 /data/b /data/b/site
    chmod 711 /data/a /data/b; chmod 755 /data /data/a/site /data/b/site
    echo "setup done"
    ;;

  sshd|sshd-rogue)
    mkusers
    hostkeydir=/pki/ssh; [ "$role" = sshd-rogue ] && hostkeydir=/pki/ssh-rogue
    mkdir -p /run/sshd /etc/ssh/authorized_keys
    cp /pki/client_key.pub /etc/ssh/authorized_keys/a
    cat >/etc/ssh/sshd_p6e <<CONF
Port 22
HostKey $hostkeydir/ssh_host_ed25519_key
UsePAM no
PasswordAuthentication yes
PubkeyAuthentication yes
AuthorizedKeysFile /etc/ssh/authorized_keys/%u
PermitRootLogin no
LogLevel VERBOSE
Subsystem sftp internal-sftp
Match User a,b
  ChrootDirectory /data
  ForceCommand internal-sftp -l VERBOSE
  AllowTcpForwarding no
  X11Forwarding no
CONF
    exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_p6e
    ;;

  ftps|ftps-rogue|ftp-plain)
    mkusers /data   # vsftpd chroots into the home dir, which must exist
    ip="$(hostname -i | awk '{print $1}')"
    certdir=/pki/ftps; [ "$role" = ftps-rogue ] && certdir=/pki/ftps-rogue
    mkdir -p /var/run/vsftpd/empty
    printf 'auth required pam_unix.so\naccount required pam_unix.so\n' >/etc/pam.d/vsftpd_p6e
    {
      cat <<CONF
listen=YES
listen_ipv6=NO
anonymous_enable=NO
local_enable=YES
write_enable=YES
local_umask=022
chroot_local_user=YES
local_root=/data
allow_writeable_chroot=NO
check_shell=NO
userlist_enable=NO
seccomp_sandbox=NO
pam_service_name=vsftpd_p6e
secure_chroot_dir=/var/run/vsftpd/empty
pasv_enable=YES
pasv_min_port=30000
pasv_max_port=30100
pasv_address=$ip
xferlog_enable=YES
xferlog_std_format=NO
vsftpd_log_file=/var/log/vsftpd.log
log_ftp_protocol=YES
dual_log_enable=NO
connect_from_port_20=NO
CONF
      if [ "$role" != ftp-plain ]; then
        cat <<CONF
ssl_enable=YES
rsa_cert_file=$certdir/cert.pem
rsa_private_key_file=$certdir/key.pem
force_local_logins_ssl=YES
force_local_data_ssl=YES
ssl_sslv2=NO
ssl_sslv3=NO
ssl_tlsv1=NO
require_ssl_reuse=NO
ssl_ciphers=HIGH
CONF
      fi
    } >/etc/vsftpd_p6e.conf
    touch /var/log/vsftpd.log; tail -F /var/log/vsftpd.log &
    exec /usr/sbin/vsftpd /etc/vsftpd_p6e.conf
    ;;

  https)
    cat >/etc/nginx/nginx.conf <<'CONF'
worker_processes 1;
pid /tmp/nginx.pid;
error_log /dev/stderr info;
events { worker_connections 256; }
http {
  include /etc/nginx/mime.types;
  access_log /dev/stdout;
  client_body_temp_path /tmp/nb; proxy_temp_path /tmp/np; fastcgi_temp_path /tmp/nf; uwsgi_temp_path /tmp/nu; scgi_temp_path /tmp/ns;
  ssl_certificate /pki/https/cert.pem;
  ssl_certificate_key /pki/https/key.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  add_header Cache-Control "no-store" always;
  server { listen 443 ssl; server_name site-a; root /data/a/site/public_html; index index.html; }
  server { listen 443 ssl; server_name site-b; root /data/b/site/public_html; index index.html; }
}
CONF
    exec nginx -g 'daemon off;'
    ;;

  probe)
    # Once /probe/run exists, GET the stamp of site-a in a tight loop and log "<epoch ns> <http code>" lines.
    mkdir -p /probe; chmod 777 /probe
    while :; do
      if [ -e /probe/run ]; then
        t=$(date +%s%N)
        code=$(curl -s -o /dev/null -m 3 --cacert /pki/ca.crt -w "%{http_code}" https://site-a/ 2>/dev/null) || code=000
        echo "$t $code" >>/probe/log
      else
        sleep 0.05
      fi
    done
    ;;

  client)
    exec sleep infinity
    ;;

  *) echo "unknown role $role" >&2; exit 2 ;;
esac
