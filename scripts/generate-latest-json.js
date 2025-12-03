const fs = require('fs');
const path = require('path');

const version = process.env.GITHUB_REF_NAME ? process.env.GITHUB_REF_NAME.replace(/^v/, '') : '0.1.0';
const pubDate = new Date().toISOString();

// Helper to read signature file
function readSignature(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            return fs.readFileSync(filePath, 'utf8').trim();
        }
    } catch (e) {
        console.warn(`Could not read signature file: ${filePath}`, e);
    }
    return null;
}

const platforms = {
    'darwin-aarch64': {
        sigFile: 'updater-artifacts/opspilot.app.tar.gz.sig',
        url: `https://github.com/ankitjain91/opspilot/releases/download/v${version}/opspilot_${version}_aarch64.app.tar.gz` // Verify naming convention
    },
    'darwin-x86_64': {
        sigFile: 'updater-artifacts/opspilot.app.tar.gz.sig', // Universal build uses same sig? Or we need specific ones?
        // Universal build usually produces one app. Let's assume universal for now as per workflow.
        url: `https://github.com/ankitjain91/opspilot/releases/download/v${version}/opspilot_${version}_universal.app.tar.gz`
    },
    'linux-x86_64': {
        sigFile: 'updater-artifacts/opspilot.AppImage.sig',
        url: `https://github.com/ankitjain91/opspilot/releases/download/v${version}/opspilot_${version}_amd64.AppImage`
    },
    'windows-x86_64': {
        sigFile: 'updater-artifacts/opspilot.exe.sig',
        url: `https://github.com/ankitjain91/opspilot/releases/download/v${version}/opspilot_${version}_x64-setup.exe`
    }
};

const updateData = {
    version,
    notes: `Update to version ${version}`,
    pub_date: pubDate,
    platforms: {}
};

for (const [key, config] of Object.entries(platforms)) {
    const signature = readSignature(config.sigFile);
    if (signature) {
        updateData.platforms[key] = {
            signature,
            url: config.url
        };
    } else {
        console.warn(`Missing signature for ${key}, skipping.`);
    }
}

console.log(JSON.stringify(updateData, null, 2));
fs.writeFileSync('latest.json', JSON.stringify(updateData, null, 2));
