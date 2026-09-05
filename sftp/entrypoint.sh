set -eu
if [ ! -s /run/secrets/authorized_keys ]; then
    echo 'At least one authorized SSH public key is required' >&2
    exit 1
fi
if [ ! -f /hostkeys/ssh_host_ed25519_key ]; then
    ssh-keygen -q -t ed25519 -N '' -f /hostkeys/ssh_host_ed25519_key
fi
mkdir -p /run/sshd
cp /run/secrets/authorized_keys /run/sshd/authorized_keys
chmod 644 /run/sshd/authorized_keys
exec /usr/sbin/sshd -D -e
