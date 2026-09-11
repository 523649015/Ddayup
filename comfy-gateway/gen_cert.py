import sys, os, datetime
try:
    from cryptography import x509
    from cryptography.x509.oid import NameOID
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
except Exception as e:
    print("NO_CRYPTOGRAPHY", e)
    sys.exit(2)

out_dir = os.path.dirname(os.path.abspath(__file__))
cert_path = os.path.join(out_dir, "gateway-selfsigned.crt")
key_path = os.path.join(out_dir, "gateway-selfsigned.key")

key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
subject = issuer = x509.Name([
    x509.NameAttribute(NameOID.COUNTRY_NAME, "CN"),
    x509.NameAttribute(NameOID.ORGANIZATION_NAME, "HMDaoLocal"),
    x509.NameAttribute(NameOID.COMMON_NAME, "127.0.0.1"),
])
now = datetime.datetime.utcnow()
cert = (
    x509.CertificateBuilder()
    .subject_name(subject)
    .issuer_name(issuer)
    .public_key(key.public_key())
    .serial_number(x509.random_serial_number())
    .not_valid_before(now)
    .not_valid_after(now + datetime.timedelta(days=3650))
    .add_extension(x509.SubjectAlternativeName([x509.DNSName("localhost"), x509.IPAddress(__import__("ipaddress").ip_address("127.0.0.1"))]), critical=False)
    .sign(key, hashes.SHA256())
)
with open(cert_path, "wb") as f:
    f.write(cert.public_bytes(serialization.Encoding.PEM))
with open(key_path, "wb") as f:
    f.write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption()))
print("CERT_OK", cert_path, key_path)
