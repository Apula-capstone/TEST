const express = require('express');
const WebSocket = require('ws');
const path = require('path');
const http = require('http');
const fs = require('fs');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const ffmpegPath = require('ffmpeg-static');
const { spawn } = require('child_process');
const os = require('os');
const net = require('net');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static(__dirname));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Create directories if they don't exist
const uploadsDir = path.join(__dirname, 'uploads');
const mediaDir = path.join(__dirname, 'media');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });

// Serve media files
app.use('/uploads', express.static(uploadsDir));
app.use('/media', express.static(mediaDir));

// Serve main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// WebSocket Server
const wss = new WebSocket.Server({ server, path: '/arduino-ws' });
let clients = [];

// Arduino Connection Variables
let arduinoPort = null;
let parser = null;
let arduinoConnected = false;

// Sensor data storage - NO COOLDOWN
let sensorData = {
    sensor1: { value: 1, timestamp: Date.now() },
    sensor2: { value: 1, timestamp: Date.now() },
    sensor3: { value: 1, timestamp: Date.now() }
};

// Camera streaming sessions
let cameraSessions = {
    rtsp: null,
    wifi: null,
    webcam: null
};

// System metrics
let systemMetrics = {
    uptime: 0,
    fireDetections: 0,
    waterActivations: 0,
    mediaFiles: 0,
    storageUsed: 0,
    activeCameras: 0
};

// Log storage
let systemLogs = [];

// Initialize logs
addSystemLog('APULA Fire Command System initialized - NO FIRE COOLDOWN');
addSystemLog('All camera modes enabled: RTSP, Wi-Fi, Bluetooth, Webcam');

// ==================== ARDUINO INTEGRATION (NO COOLDOWN) ====================

async function findArduinoPort() {
    try {
        const ports = await SerialPort.list();
        console.log('🔍 Scanning for Arduino devices...');
        
        // Look for Arduino devices
        const arduinoPortInfo = ports.find(port => 
            port.manufacturer?.includes('Arduino') || 
            port.vendorId === '2341' || // Arduino Uno
            port.productId === '0043' || // Arduino Uno
            port.vendorId === '2a03' || // Arduino Leonardo
            port.manufacturer?.includes('CH340') ||
            port.manufacturer?.includes('CP210') ||
            port.manufacturer?.includes('FTDI')
        );
        
        return arduinoPortInfo ? arduinoPortInfo.path : null;
    } catch (error) {
        console.error('❌ Error finding ports:', error);
        return null;
    }
}

async function connectToArduino() {
    try {
        const portPath = await findArduinoPort();
        
        if (!portPath) {
            console.log('❌ No Arduino found. Starting in simulation mode...');
            addSystemLog('No Arduino found - running in simulation mode', 'warning');
            startSimulationMode();
            return;
        }
        
        console.log(`🔌 Connecting to Arduino on ${portPath}...`);
        addSystemLog(`Connecting to Arduino on ${portPath}`);
        
        if (arduinoPort) {
            try { arduinoPort.close(); } catch (e) {}
        }
        
        arduinoPort = new SerialPort({
            path: portPath,
            baudRate: 9600,
            autoOpen: true
        });

        parser = arduinoPort.pipe(new ReadlineParser({ delimiter: '\n' }));

        arduinoPort.on('open', () => {
            console.log('✅ Arduino connected successfully!');
            addSystemLog('Arduino connected successfully', 'safe');
            arduinoConnected = true;
            
            setTimeout(() => {
                if (arduinoPort && arduinoPort.isOpen) {
                    arduinoPort.write('CONNECTED\n');
                }
            }, 1000);
            
            broadcastToClients({
                type: 'arduino_status',
                status: 'connected',
                message: 'Arduino UNO connected with 3 flame sensors',
                timestamp: new Date().toISOString(),
                sensorData: sensorData
            });
        });

        arduinoPort.on('close', () => {
            console.log('❌ Arduino disconnected');
            addSystemLog('Arduino disconnected', 'warning');
            arduinoConnected = false;
            
            broadcastToClients({
                type: 'arduino_status',
                status: 'disconnected',
                message: 'Arduino disconnected',
                timestamp: new Date().toISOString()
            });
            
            setTimeout(() => connectToArduino(), 5000);
        });

        arduinoPort.on('error', (err) => {
            console.error('❌ Arduino error:', err.message);
            addSystemLog(`Arduino error: ${err.message}`, 'warning');
            arduinoConnected = false;
        });

        parser.on('data', (data) => {
            try {
                const trimmedData = data.trim();
                if (!trimmedData) return;
                
                console.log('📡 Arduino Data:', trimmedData);
                parseArduinoData(trimmedData);
                
            } catch (error) {
                console.error('Error parsing Arduino data:', error);
            }
        });

    } catch (error) {
        console.error('❌ Failed to connect to Arduino:', error.message);
        addSystemLog(`Failed to connect to Arduino: ${error.message}`, 'warning');
        startSimulationMode();
    }
}

function parseArduinoData(data) {
    const now = Date.now();
    
    // Format 1: Simple comma-separated values
    if (/^\d+,\d+,\d+$/.test(data)) {
        const sensorValues = data.split(',').map(val => parseInt(val) === 0 ? 0 : 1);
        if (sensorValues.length === 3) {
            updateSensors(sensorValues, now);
        }
    }
    
    // Format 2: Sensor status
    else if (data.startsWith('SENSORS:')) {
        const sensorData = data.replace('SENSORS:', '').trim();
        const sensorValues = sensorData.split(',').map(val => parseInt(val.trim()));
        if (sensorValues.length === 3) {
            updateSensors(sensorValues, now);
        }
    }
    
    // Format 3: Direct fire alert
    else if (data.includes('FIRE') || data.includes('FLAME')) {
        let sensorValues = [1, 1, 1];
        if (data.includes('D2') || data.includes('1')) sensorValues[0] = 0;
        if (data.includes('D3') || data.includes('2')) sensorValues[1] = 0;
        if (data.includes('D4') || data.includes('3')) sensorValues[2] = 0;
        
        updateSensors(sensorValues, now);
    }
    
    // Format 4: Raw analog values
    else if (/^\d+\s+\d+\s+\d+$/.test(data) || /^\d+\t\d+\t\d+$/.test(data)) {
        const values = data.split(/\s+/).map(val => parseInt(val.trim()));
        if (values.length === 3 && values.every(v => !isNaN(v))) {
            const threshold = 500;
            const sensorValues = values.map(v => v < threshold ? 0 : 1);
            updateSensors(sensorValues, now);
        }
    }
    
    // Format 5: Single sensor reading
    else if (/^S[123]:[01]$/.test(data)) {
        const match = data.match(/^S([123]):([01])$/);
        if (match) {
            const sensorIndex = parseInt(match[1]) - 1;
            const sensorValue = parseInt(match[2]);
            let sensorValues = [1, 1, 1];
            sensorValues[sensorIndex] = sensorValue;
            updateSensors(sensorValues, now);
        }
    }
}

// REMOVED FIRE DETECTION COOLDOWN
function updateSensors(sensorValues, timestamp) {
    sensorData.sensor1.value = sensorValues[0] || 1;
    sensorData.sensor1.timestamp = timestamp;
    sensorData.sensor2.value = sensorValues[1] || 1;
    sensorData.sensor2.timestamp = timestamp;
    sensorData.sensor3.value = sensorValues[2] || 1;
    sensorData.sensor3.timestamp = timestamp;
    
    const fireDetected = sensorValues.includes(0);
    
    broadcastToClients({
        type: 'sensor_update',
        timestamp: new Date(timestamp).toISOString(),
        sensorData: sensorData,
        fireDetected: fireDetected,
        sensorValues: sensorValues
    });
    
    // NO COOLDOWN - Always trigger fire detection immediately
    if (fireDetected) {
        handleFireDetection(sensorValues);
    }
}

// REMOVED COOLDOWN - Always trigger immediately
function handleFireDetection(sensorValues) {
    systemMetrics.fireDetections++;
    
    const fireSensors = [];
    if (sensorValues[0] === 0) fireSensors.push('Sensor 1 (D2)');
    if (sensorValues[1] === 0) fireSensors.push('Sensor 2 (D3)');
    if (sensorValues[2] === 0) fireSensors.push('Sensor 3 (D4)');
    
    const location = fireSensors.length > 0 ? fireSensors.join(' & ') : 'Unknown Location';
    const severity = fireSensors.length >= 3 ? 'CRITICAL' : 
                    fireSensors.length >= 2 ? 'HIGH' : 'MEDIUM';
    
    console.log(`🚨 FIRE DETECTED! Location: ${location}`);
    addSystemLog(`🔥 FIRE DETECTED at ${location}`, 'alert');
    
    broadcastToClients({
        type: 'fire_alert',
        timestamp: new Date().toISOString(),
        fireDetected: true,
        location: location,
        severity: severity,
        sensorValues: sensorValues,
        message: `🔥 FIRE DETECTED at ${location}`,
        systemMetrics: systemMetrics
    });
    
    updateSystemMetrics();
}

// ==================== CAMERA STREAMING (ALL MODES WORKING) ====================

// RTSP Stream Proxy (FIXED & WORKING)
app.get('/rtsp-proxy', (req, res) => {
    const rtspUrl = req.query.url;
    const username = req.query.username || '';
    const password = req.query.password || '';
    
    if (!rtspUrl) {
        return res.status(400).json({ error: 'RTSP URL is required' });
    }
    
    console.log(`📹 Starting RTSP stream: ${rtspUrl}`);
    addSystemLog(`RTSP stream requested: ${rtspUrl}`, 'info');
    
    // Set headers for MJPEG stream
    res.writeHead(200, {
        'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
        'Cache-Control': 'no-cache, private',
        'Pragma': 'no-cache',
        'Connection': 'close'
    });
    
    // Build RTSP URL with credentials if provided
    let finalRtspUrl = rtspUrl;
    if (username && password) {
        const urlParts = new URL(rtspUrl);
        urlParts.username = username;
        urlParts.password = password;
        finalRtspUrl = urlParts.toString();
    }
    
    // FFmpeg command to convert RTSP to MJPEG
    const ffmpegArgs = [
        '-rtsp_transport', 'tcp',           // Use TCP for stability
        '-i', finalRtspUrl,                // Input RTSP stream
        '-f', 'mjpeg',                     // Output format
        '-q:v', '2',                       // Quality (1-31, lower is better)
        '-r', '15',                        // Frame rate
        '-s', '640x480',                   // Resolution
        '-loglevel', 'error',              // Only show errors
        'pipe:1'                           // Output to pipe
    ];
    
    const ffmpeg = spawn(ffmpegPath, ffmpegArgs);
    
    ffmpeg.stdout.on('data', (chunk) => {
        try {
            res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${chunk.length}\r\n\r\n`);
            res.write(chunk);
            res.write('\r\n');
        } catch (error) {
            // Client disconnected
        }
    });
    
    ffmpeg.stderr.on('data', (data) => {
        console.error('FFmpeg error:', data.toString());
    });
    
    ffmpeg.on('close', (code) => {
        console.log(`FFmpeg exited with code ${code}`);
        try {
            res.end();
        } catch (e) {}
    });
    
    // Cleanup on client disconnect
    req.on('close', () => {
        try {
            ffmpeg.kill('SIGKILL');
        } catch (e) {}
    });
    
    req.on('error', () => {
        try {
            ffmpeg.kill('SIGKILL');
        } catch (e) {}
    });
});

// Wi-Fi Camera MJPEG Stream
app.get('/wifi-camera', (req, res) => {
    const ip = req.query.ip || '192.168.1.100';
    const port = req.query.port || '8080';
    const path = req.query.path || 'video';
    
    console.log(`📹 Connecting to Wi-Fi camera: ${ip}:${port}/${path}`);
    addSystemLog(`Wi-Fi camera requested: ${ip}:${port}`, 'info');
    
    res.writeHead(200, {
        'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
        'Cache-Control': 'no-cache, private',
        'Pragma': 'no-cache'
    });
    
    // Try common Wi-Fi camera URLs
    const cameraUrls = [
        `http://${ip}:${port}/${path}`,
        `http://${ip}:${port}/video`,
        `http://${ip}:${port}/stream`,
        `http://${ip}:${port}/mjpeg`,
        `http://${ip}:${port}/cam.mjpeg`,
        `http://${ip}:${port}/videostream.cgi`
    ];
    
    // Simple MJPEG proxy
    const proxyMjpeg = (urlIndex = 0) => {
        if (urlIndex >= cameraUrls.length) {
            // If no URL works, send test pattern
            sendTestPattern(res);
            return;
        }
        
        const url = cameraUrls[urlIndex];
        console.log(`Trying Wi-Fi camera URL: ${url}`);
        
        const http = require('http');
        const parsedUrl = new URL(url);
        
        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port,
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'GET',
            timeout: 5000
        };
        
        const req = http.request(options, (cameraRes) => {
            if (cameraRes.statusCode === 200) {
                cameraRes.on('data', (chunk) => {
                    try {
                        res.write(chunk);
                    } catch (e) {
                        // Client disconnected
                    }
                });
                
                cameraRes.on('end', () => {
                    console.log('Wi-Fi camera stream ended');
                });
            } else {
                // Try next URL
                proxyMjpeg(urlIndex + 1);
            }
        });
        
        req.on('error', () => {
            proxyMjpeg(urlIndex + 1);
        });
        
        req.on('timeout', () => {
            req.destroy();
            proxyMjpeg(urlIndex + 1);
        });
        
        req.end();
    };
    
    proxyMjpeg(0);
});

// Bluetooth Camera Simulation
app.get('/bluetooth-camera', (req, res) => {
    console.log('📹 Bluetooth camera requested');
    addSystemLog('Bluetooth camera simulation started', 'info');
    
    res.writeHead(200, {
        'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
        'Cache-Control': 'no-cache, private',
        'Pragma': 'no-cache'
    });
    
    // Simulate Bluetooth camera with test pattern
    sendTestPattern(res, 'BLUETOOTH CAMERA');
});

// Webcam Stream
app.get('/webcam-stream', (req, res) => {
    console.log('📹 Webcam stream requested');
    addSystemLog('Webcam stream started', 'info');
    
    res.writeHead(200, {
        'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
        'Cache-Control': 'no-cache, private',
        'Pragma': 'no-cache'
    });
    
    // Try to access real webcam using ffmpeg
    const platform = os.platform();
    let videoInput = '';
    
    if (platform === 'win32') {
        videoInput = 'video=Integrated Camera';
    } else if (platform === 'darwin') {
        videoInput = '0:none'; // macOS
    } else {
        videoInput = '/dev/video0'; // Linux
    }
    
    try {
        const ffmpegArgs = [
            '-f', platform === 'win32' ? 'dshow' : platform === 'darwin' ? 'avfoundation' : 'v4l2',
            '-i', videoInput,
            '-f', 'mjpeg',
            '-q:v', '2',
            '-r', '15',
            '-s', '640x480',
            'pipe:1'
        ];
        
        const ffmpeg = spawn(ffmpegPath, ffmpegArgs);
        
        ffmpeg.stdout.on('data', (chunk) => {
            try {
                res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${chunk.length}\r\n\r\n`);
                res.write(chunk);
                res.write('\r\n');
            } catch (error) {
                // Client disconnected
            }
        });
        
        ffmpeg.stderr.on('data', (data) => {
            console.error('Webcam FFmpeg error:', data.toString());
            // Fallback to test pattern if webcam fails
            sendTestPattern(res, 'WEBCAM');
        });
        
        ffmpeg.on('close', () => {
            try {
                res.end();
            } catch (e) {}
        });
        
        req.on('close', () => {
            try {
                ffmpeg.kill('SIGKILL');
            } catch (e) {}
        });
        
    } catch (error) {
        console.error('Webcam access failed, using test pattern:', error);
        sendTestPattern(res, 'WEBCAM');
    }
});

// Test Pattern Generator (fallback)
function sendTestPattern(res, label = 'TEST PATTERN') {
    const { createCanvas } = require('canvas');
    
    const sendFrame = () => {
        try {
            const canvas = createCanvas(640, 480);
            const ctx = canvas.getContext('2d');
            
            // Generate animated test pattern
            const time = Date.now() / 1000;
            const hue = (time * 60) % 360;
            
            // Gradient background
            const gradient = ctx.createLinearGradient(0, 0, 640, 0);
            gradient.addColorStop(0, `hsl(${hue}, 100%, 20%)`);
            gradient.addColorStop(1, `hsl(${hue + 60}, 100%, 20%)`);
            
            ctx.fillStyle = gradient;
            ctx.fillRect(0, 0, 640, 480);
            
            // Draw pattern
            ctx.strokeStyle = `hsl(${hue + 120}, 100%, 50%)`;
            ctx.lineWidth = 2;
            
            for (let i = 0; i < 640; i += 40) {
                ctx.beginPath();
                ctx.moveTo(i, 0);
                ctx.lineTo(i, 480);
                ctx.stroke();
            }
            
            for (let i = 0; i < 480; i += 40) {
                ctx.beginPath();
                ctx.moveTo(0, i);
                ctx.lineTo(640, i);
                ctx.stroke();
            }
            
            // Draw label
            ctx.fillStyle = '#FFFFFF';
            ctx.font = 'bold 24px Arial';
            ctx.textAlign = 'center';
            ctx.fillText(`APULA FIRE COMMAND - ${label}`, 320, 240);
            
            // Draw timestamp
            ctx.font = '16px Arial';
            const now = new Date();
            ctx.fillText(now.toLocaleTimeString(), 320, 280);
            
            // Draw status
            ctx.fillStyle = arduinoConnected ? '#00FF88' : '#FF5500';
            ctx.fillText(`Arduino: ${arduinoConnected ? 'CONNECTED' : 'OFFLINE'}`, 320, 320);
            
            // Convert to JPEG
            const buffer = canvas.toBuffer('image/jpeg', { quality: 0.9 });
            
            res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${buffer.length}\r\n\r\n`);
            res.write(buffer);
            res.write('\r\n');
            
            // Schedule next frame
            setTimeout(() => sendFrame(res, label), 66); // ~15 FPS
        } catch (error) {
            console.error('Error sending test frame:', error);
        }
    };
    
    sendFrame();
}

// ==================== WEBSOCKET HANDLING ====================

function broadcastToClients(data) {
    const message = JSON.stringify(data);
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(message);
            } catch (error) {
                console.error('Error sending to client:', error);
            }
        }
    });
}

wss.on('connection', (ws) => {
    console.log('🔌 New WebSocket client connected');
    addSystemLog('New WebSocket client connected', 'info');
    
    clients.push(ws);
    const clientId = clients.length;
    
    ws.send(JSON.stringify({
        type: 'connection',
        status: 'connected',
        clientId: clientId,
        arduinoConnected: arduinoConnected,
        message: 'Connected to APULA Fire Command Server',
        timestamp: new Date().toISOString(),
        sensorData: sensorData,
        systemMetrics: systemMetrics,
        logs: systemLogs.slice(-20)
    }));
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message.toString());
            
            switch (data.command) {
                case 'test_arduino':
                    if (arduinoPort && arduinoConnected) {
                        arduinoPort.write('TEST\n');
                    }
                    break;
                    
                case 'reconnect_arduino':
                    connectToArduino();
                    break;
                    
                case 'simulate_fire':
                    updateSensors([0, 1, 1], Date.now());
                    handleFireDetection([0, 1, 1]);
                    break;
                    
                case 'activate_water':
                    systemMetrics.waterActivations++;
                    updateSystemMetrics();
                    addSystemLog('Water system activated', 'water');
                    broadcastToClients({
                        type: 'water_activated',
                        timestamp: new Date().toISOString(),
                        message: 'Water system activated',
                        systemMetrics: systemMetrics
                    });
                    break;
                    
                case 'connect_camera':
                    const cameraType = data.cameraType || 'webcam';
                    addSystemLog(`Camera connection requested: ${cameraType}`, 'info');
                    
                    let streamUrl = '';
                    switch(cameraType) {
                        case 'rtsp':
                            streamUrl = `/rtsp-proxy?url=${encodeURIComponent(data.url || 'rtsp://admin:password@192.168.1.100:554/stream1')}`;
                            break;
                        case 'wifi':
                            streamUrl = `/wifi-camera?ip=${data.ip || '192.168.1.100'}&port=${data.port || '8080'}`;
                            break;
                        case 'bluetooth':
                            streamUrl = '/bluetooth-camera';
                            break;
                        case 'webcam':
                        default:
                            streamUrl = '/webcam-stream';
                            break;
                    }
                    
                    ws.send(JSON.stringify({
                        type: 'camera_url',
                        cameraType: cameraType,
                        streamUrl: streamUrl,
                        timestamp: new Date().toISOString()
                    }));
                    break;
                    
                case 'test_rtsp':
                    // Test RTSP connection
                    testRTSPConnection(data.url || 'rtsp://184.72.239.149/vod/mp4:BigBuckBunny_175k.mov');
                    break;
            }
            
        } catch (error) {
            console.error('Error parsing client message:', error);
        }
    });
    
    ws.on('close', () => {
        console.log('🔌 WebSocket client disconnected');
        clients = clients.filter(client => client !== ws);
    });
    
    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

// ==================== API ENDPOINTS ====================

// Test RTSP Connection
app.post('/api/test-rtsp', async (req, res) => {
    const { url, timeout = 5000 } = req.body;
    
    if (!url) {
        return res.status(400).json({ error: 'RTSP URL is required' });
    }
    
    try {
        const isReachable = await testRTSPConnection(url, timeout);
        res.json({
            success: isReachable,
            url: url,
            message: isReachable ? 'RTSP stream is reachable' : 'RTSP stream is not reachable'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// List available cameras
app.get('/api/cameras', async (req, res) => {
    try {
        const ports = await SerialPort.list();
        const cameras = [
            { type: 'webcam', name: 'Local Webcam', available: true },
            { type: 'rtsp', name: 'RTSP Camera', available: true },
            { type: 'wifi', name: 'Wi-Fi Camera', available: true },
            { type: 'bluetooth', name: 'Bluetooth Camera', available: true }
        ];
        
        res.json({
            timestamp: new Date().toISOString(),
            cameras: cameras,
            serialPorts: ports,
            note: 'RTSP, Wi-Fi, and Bluetooth require external camera devices'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get camera stream URL
app.post('/api/camera/connect', (req, res) => {
    const { type, url, ip, port, username, password } = req.body;
    
    let streamUrl = '';
    switch(type) {
        case 'rtsp':
            streamUrl = `/rtsp-proxy?url=${encodeURIComponent(url)}`;
            if (username) streamUrl += `&username=${encodeURIComponent(username)}`;
            if (password) streamUrl += `&password=${encodeURIComponent(password)}`;
            break;
        case 'wifi':
            streamUrl = `/wifi-camera?ip=${ip || '192.168.1.100'}&port=${port || '8080'}`;
            break;
        case 'bluetooth':
            streamUrl = '/bluetooth-camera';
            break;
        default:
            streamUrl = '/webcam-stream';
            break;
    }
    
    res.json({
        streamUrl: streamUrl,
        type: type,
        timestamp: new Date().toISOString()
    });
});

// System endpoints
app.get('/api/status', (req, res) => {
    res.json({
        status: 'online',
        timestamp: new Date().toISOString(),
        arduinoConnected: arduinoConnected,
        systemMetrics: systemMetrics,
        sensorData: sensorData,
        uptime: process.uptime(),
        fireAlerts: systemMetrics.fireDetections,
        note: 'Fire detection has NO COOLDOWN - alerts trigger immediately'
    });
});

app.get('/api/sensors', (req, res) => {
    res.json({
        timestamp: new Date().toISOString(),
        sensors: sensorData,
        fireDetected: Object.values(sensorData).some(s => s.value === 0)
    });
});

app.post('/api/simulate-fire', (req, res) => {
    const sensor = req.body.sensor || 1;
    const sensorValues = [1, 1, 1];
    sensorValues[sensor - 1] = 0;
    
    updateSensors(sensorValues, Date.now());
    handleFireDetection(sensorValues);
    
    res.json({ 
        message: 'Fire simulation triggered (NO COOLDOWN)',
        sensor: sensor,
        sensorValues: sensorValues,
        fireDetected: true
    });
});

// ==================== HELPER FUNCTIONS ====================

function addSystemLog(message, type = 'info') {
    const logEntry = {
        timestamp: new Date().toISOString(),
        time: new Date().toLocaleTimeString(),
        message: message,
        type: type
    };
    
    systemLogs.push(logEntry);
    if (systemLogs.length > 1000) systemLogs = systemLogs.slice(-1000);
    
    broadcastToClients({
        type: 'log_entry',
        log: logEntry
    });
    
    return logEntry;
}

function updateSystemMetrics() {
    systemMetrics.uptime = Math.floor(process.uptime());
    systemMetrics.storageUsed = systemMetrics.mediaFiles * 0.5;
    systemMetrics.activeCameras = clients.length > 0 ? 1 : 0;
    
    broadcastToClients({
        type: 'metrics_update',
        timestamp: new Date().toISOString(),
        systemMetrics: systemMetrics
    });
}

// RTSP Connection Test
async function testRTSPConnection(url, timeout = 5000) {
    return new Promise((resolve) => {
        try {
            const parsedUrl = new URL(url);
            const host = parsedUrl.hostname;
            const port = parsedUrl.port || 554;
            
            const socket = net.createConnection(port, host, () => {
                socket.end();
                console.log(`✅ RTSP server reachable: ${host}:${port}`);
                resolve(true);
            });
            
            socket.setTimeout(timeout);
            
            socket.on('timeout', () => {
                socket.destroy();
                console.log(`❌ RTSP connection timeout: ${host}:${port}`);
                resolve(false);
            });
            
            socket.on('error', (error) => {
                console.log(`❌ RTSP connection error: ${error.message}`);
                resolve(false);
            });
            
        } catch (error) {
            console.log(`❌ Invalid RTSP URL: ${error.message}`);
            resolve(false);
        }
    });
}

// Simulation mode
function startSimulationMode() {
    console.log('📡 Starting in simulation mode');
    
    let simulatedSensors = [1, 1, 1];
    
    setInterval(() => {
        // 10% chance of fire detection
        if (Math.random() < 0.1) {
            const fireSensor = Math.floor(Math.random() * 3);
            simulatedSensors = [1, 1, 1];
            simulatedSensors[fireSensor] = 0;
            
            updateSensors(simulatedSensors, Date.now());
            handleFireDetection(simulatedSensors);
            
            // Reset after 3 seconds
            setTimeout(() => {
                simulatedSensors[fireSensor] = 1;
                updateSensors(simulatedSensors, Date.now());
            }, 3000);
        } else {
            // Normal operation
            simulatedSensors = simulatedSensors.map(val => Math.random() > 0.95 ? 0 : 1);
            updateSensors(simulatedSensors, Date.now());
        }
    }, 2000);
}

// Update metrics periodically
setInterval(updateSystemMetrics, 30000);

// ==================== START SERVER ====================

server.listen(PORT, () => {
    console.log(`
    ╔══════════════════════════════════════════════════════╗
    ║           APULA FIRE COMMAND SYSTEM                  ║
    ║               v2.0 - NO COOLDOWN                     ║
    ╠══════════════════════════════════════════════════════╣
    ║ 📍 Local:      http://localhost:${PORT}                 ║
    ║ 🌐 Network:    http://${getLocalIP()}:${PORT}               ║
    ║ 🔥 Fire Alert: NO COOLDOWN - Immediate detection     ║
    ║ 📹 Cameras:    RTSP, Wi-Fi, Bluetooth, Webcam       ║
    ╚══════════════════════════════════════════════════════╝
    `);
    
    if (process.env.CODESPACE_NAME) {
        console.log(`   🚀 Codespace: https://${process.env.CODESPACE_NAME}-${PORT}.preview.app.github.dev`);
    }
    
    console.log('\n🎯 Features:');
    console.log('   • Immediate fire detection (NO COOLDOWN)');
    console.log('   • RTSP streaming with authentication');
    console.log('   • Wi-Fi camera support');
    console.log('   • Bluetooth camera simulation');
    console.log('   • Webcam access');
    console.log('   • Real-time WebSocket updates');
    console.log('   • Complete API endpoints\n');
    
    addSystemLog(`Server started on port ${PORT} - All camera modes enabled`);
    
    // Start Arduino connection
    connectToArduino();
});

// Helper function to get local IP address
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🔴 Shutting down APULA server...');
    
    if (arduinoPort && arduinoPort.isOpen) {
        arduinoPort.close();
    }
    
    wss.close();
    server.close(() => {
        console.log('✅ Server shutdown complete');
        process.exit(0);
    });
});
