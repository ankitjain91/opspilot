const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const https = require('https');

const VERSION = 'v0.1.0'; // This should match package.json version
const BASE_URL = `https://github.com/ankitjain91/opspilot/releases/download/${VERSION}`;

const platform = process.platform;
const arch = process.arch;

let filename = '';
let binaryName = 'opspilot';

if (platform === 'darwin') {
    if (arch === 'arm64') {
        filename = 'opspilot-aarch64-apple-darwin.tar.gz';
    } else {
        filename = 'opspilot-x86_64-apple-darwin.tar.gz';
    }
} else if (platform === 'linux') {
    filename = 'opspilot-x86_64-unknown-linux-gnu.tar.gz';
} else if (platform === 'win32') {
    filename = 'opspilot-x86_64-pc-windows-msvc.zip';
    binaryName = 'opspilot.exe';
} else {
    console.error(`Unsupported platform: ${platform}-${arch}`);
    process.exit(1);
}

const url = `${BASE_URL}/${filename}`;
const binDir = path.join(__dirname, 'bin');
const destPath = path.join(binDir, filename);
const finalBinaryPath = path.join(binDir, binaryName);

if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir);
}

console.log(`Downloading OpsPilot ${VERSION} for ${platform}-${arch}...`);
console.log(`URL: ${url}`);

const file = fs.createWriteStream(destPath);

https.get(url, (response) => {
    if (response.statusCode === 302 || response.statusCode === 301) {
        // Handle redirect
        https.get(response.headers.location, (res) => {
            res.pipe(file);
            file.on('finish', () => {
                file.close(extract);
            });
        });
    } else if (response.statusCode === 200) {
        response.pipe(file);
        file.on('finish', () => {
            file.close(extract);
        });
    } else {
        console.error(`Failed to download: ${response.statusCode}`);
        process.exit(1);
    }
}).on('error', (err) => {
    fs.unlink(destPath, () => { });
    console.error(`Error downloading: ${err.message}`);
    process.exit(1);
});

function extract() {
    console.log('Extracting...');
    try {
        if (destPath.endsWith('.zip')) {
            // Simple zip extraction for Windows (requires unzip or powershell, but let's assume tar might work on modern windows or use a library? 
            // To keep it dependency-free, we might need a simpler approach or just use tar if available.
            // Node 20 has built-in unzip? No.
            // Let's use tar for everything if possible, but Windows zip is tricky without dependencies.
            // For now, let's assume 'tar' exists on Windows (it does in Win10+)
            execSync(`tar -xf "${destPath}" -C "${binDir}"`);
        } else {
            execSync(`tar -xzf "${destPath}" -C "${binDir}"`);
        }

        // Cleanup
        fs.unlinkSync(destPath);

        // Make executable
        if (platform !== 'win32') {
            fs.chmodSync(finalBinaryPath, 0o755);
        }

        console.log('OpsPilot installed successfully!');
    } catch (e) {
        console.error('Extraction failed:', e.message);
        process.exit(1);
    }
}
