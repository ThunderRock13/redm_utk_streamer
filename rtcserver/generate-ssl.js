const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const sslDir = path.join(__dirname, 'ssl');
const serverIP = '192.99.60.230';

// Ensure SSL directory exists
if (!fs.existsSync(sslDir)) {
    fs.mkdirSync(sslDir, { recursive: true });
}

// Create OpenSSL config for SAN certificate
const opensslConfig = `[req]
distinguished_name = req_distinguished_name
req_extensions = v3_req
prompt = no

[req_distinguished_name]
C=US
ST=State
L=City
O=RedM Streaming Server
CN=localhost

[v3_req]
basicConstraints = CA:FALSE
keyUsage = nonRepudiation, digitalSignature, keyEncipherment
subjectAltName = @alt_names

[alt_names]
DNS.1 = localhost
DNS.2 = *.localhost
IP.1 = 127.0.0.1
IP.2 = ${serverIP}
`;

const configPath = path.join(sslDir, 'openssl.cnf');

console.log('Generating SSL certificate with SAN for CFX compatibility...');

try {
    // Write OpenSSL config
    fs.writeFileSync(configPath, opensslConfig);

    // Generate private key
    execSync(`openssl genrsa -out "${path.join(sslDir, 'key.pem')}" 2048`);

    // Generate certificate with SAN extensions
    execSync(`openssl req -new -x509 -key "${path.join(sslDir, 'key.pem')}" -out "${path.join(sslDir, 'cert.pem')}" -days 365 -config "${configPath}" -extensions v3_req`);

    console.log('✅ SSL certificate with SAN generated successfully!');
    console.log(`📁 Certificate files saved to: ${sslDir}`);
    console.log(`📍 Certificate includes IP: ${serverIP} and DNS: localhost`);
    console.log('🔒 Server will now support HTTPS/WSS connections');
    console.log('⚠️  For CFX: Certificate is self-signed, may need client trust configuration');

    // Clean up config file
    fs.unlinkSync(configPath);

} catch (error) {
    console.error('❌ SSL certificate generation failed:', error.message);
    console.log('💡 Please ensure OpenSSL is installed and available in PATH');
    console.log('💡 For Windows: https://slproweb.com/products/Win32OpenSSL.html');
}