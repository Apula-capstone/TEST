const express = require('express');
const WebSocket = require('ws');
const path = require('path');
const SerialPort = require('serialport');
const Readline = require('@serialport/parser-readline');

const app = express();
const PORT = 3000;

// Serve static files
app.use(express.static(__dirname));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Start HTTP server
const server = app.listen(PORT, () => {
    console.log(`✅ APULA Server running: http://localhost:${PORT}`);
    console.log(`🌐 For Codespace: https://${process.env.CODESPACE_NAME}-${PORT}.preview.app.github.dev`);
});

// WebSocket Server
const wss = new WebSocket.Server({ server, path: '/arduino-ws' });
let clients = [];

// Arduino Connection Variables
let arduinoPort = null;
let parser = null;
let arduinoConnected = false;

// Find Arduino port automatically
async function findArduinoPort() {
    try {
        const ports = await SerialPort.list();
        console.log('Available ports:', ports.map(p => ({ path: p.path, manufacturer: p.manufacturer })));
        
        // Look for Arduino (common vendor IDs)
        const arduinoPortInfo = ports.find(port => 
            port.manufacturer?.includes('Arduino') || 
            port.vendorId === '2341' || // Arduino Uno
            port.productId === '0043' || // Arduino Uno
            port.productId === '0042' || // Arduino Mega
            port.vendorId === '2a03' || // Arduino Leonardo
            port.manufacturer?.includes('CH340') || // Common USB-to-Serial
            port.manufacturer?.includes('CP210')
        );
        
        return arduinoPortInfo ? arduinoPortInfo.path : null;
    } catch (error) {
        console.error('Error finding ports:', error);
        return null;
    }
}

// Connect to Arduino
async function connectToArduino() {
    try {
        const portPath = await findArduinoPort();
        
        if (!portPath) {
            console.log('❌ No Arduino found. Starting in simulation mode...');
            startSimulationMode();
            return;
        }
        
        console.log(`🔌 Connecting to Arduino on ${portPath}...`);
        
        arduinoPort = new SerialPort({
            path: portPath,
            baudRate: 9600,
            dataBits: 8,
            parity: 'none',
            stopBits: 1,
            autoOpen: true
        });

        parser = arduinoPort.pipe(new Readline({ delimiter: '\n' }));

        arduinoPort.on('open', () => {
            console.log('✅ Arduino connected successfully!');
            arduinoConnected = true;
            
            // Send initial message to Arduino
            setTimeout(() => {
                arduinoPort.write('CONNECTED\n');
            }, 1000);
            
            broadcastToClients({
                type: 'arduino_status',
                status: 'connected',
                message: 'Arduino UNO connected with 3 flame sensors',
                timestamp: new Date().toISOString()
            });
        });

        arduinoPort.on('close', () => {
            console.log('❌ Arduino disconnected');
            arduinoConnected = false;
            broadcastToClients({
                type: 'arduino_status',
                status: 'disconnected',
                message: 'Arduino disconnected',
                timestamp: new Date().toISOString()
            });
            
            // Try to reconnect after 5 seconds
            setTimeout(connectToArduino, 5000);
        });

        arduinoPort.on('error', (err) => {
            console.error('❌ Arduino error:', err.message);
            arduinoConnected = false;
            broadcastToClients({
                type: 'arduino_status',
                status: 'error',
                message: `Arduino error: ${err.message}`,
                timestamp: new Date().toISOString()
            });
        });

        // Handle incoming Arduino data
        parser.on('data', (data) => {
            const trimmedData = data.trim();
            console.log('📡 Arduino Data:', trimmedData);
            
            // Parse sensor data from Arduino
            // Format expected: "SENSORS:0,1,0" (where 0=fire, 1=no fire)
            if (trimmedData.includes('SENSORS:')) {
                const sensorData = trimmedData.split(':')[1];
                const sensors = sensorData.split(',').map(val => parseInt(val));
                
                // Check for fire (0 = fire detected)
                const fireDetected = sensors.includes(0);
                
                const message = {
                    type: 'sensor_data',
                    timestamp: new Date().toISOString(),
                    fireDetected: fireDetected,
                    sensorValues: sensors,
                    raw: trimmedData
                };
                
                if (fireDetected) {
                    message.type = 'fire_alert';
                    message.location = getFireLocation(sensors);
                    message.message = `🔥 FIRE DETECTED! Location: ${message.location}`;
                    console.log('🚨 FIRE ALERT:', message.message);
                } else {
                    message.message = 'No fire detected';
                }
                
                broadcastToClients(message);
                
            } else if (trimmedData.includes('FIRE')) {
                // Direct fire alert from Arduino
                broadcastToClients({
                    type: 'fire_alert',
                    timestamp: new Date().toISOString(),
                    fireDetected: true,
                    message: '🔥 FIRE DETECTED by Arduino!',
                    raw: trimmedData
                });
                console.log('🚨 FIRE ALERT from Arduino');
            }
        });

    } catch (error) {
        console.error('❌ Failed to connect to Arduino:', error.message);
        startSimulationMode();
    }
}

// Determine fire location based on which sensor detected fire
function getFireLocation(sensors) {
    const locations = [];
    if (sensors[0] === 0) locations.push('Sensor 1 (D2)');
    if (sensors[1] === 0) locations.push('Sensor 2 (D3)');
    if (sensors[2] === 0) locations.push('Sensor 3 (D4)');
    
    return locations.length > 0 ? locations.join(' & ') : 'Unknown Location';
}

// Simulation mode (for testing without Arduino)
function startSimulationMode() {
    console.log('📡 Starting in simulation mode (no Arduino connected)');
    
    let simulatedSensors = [1, 1, 1]; // 1 = no fire, 0 = fire
    
    setInterval(() => {
        // 15% chance of fire for testing
        if (Math.random() < 0.15) {
            const fireSensor = Math.floor(Math.random() * 3);
            simulatedSensors = [1, 1, 1];
            simulatedSensors[fireSensor] = 0; // Fire detected
            
            broadcastToClients({
                type: 'fire_alert',
                timestamp: new Date().toISOString(),
                fireDetected: true,
                sensorValues: [...simulatedSensors],
                location: `Sensor ${fireSensor + 1} (D${fireSensor + 2})`,
                message: `🔥 SIMULATION: Fire detected at Sensor ${fireSensor + 1}`,
                isSimulation: true
            });
            
            // Reset after 10 seconds
            setTimeout(() => {
                simulatedSensors[fireSensor] = 1;
            }, 10000);
        } else {
            // Normal operation
            simulatedSensors = simulatedSensors.map(val => 
                Math.random() > 0.9 ? 0 : 1
            );
            
            broadcastToClients({
                type: 'sensor_data',
                timestamp: new Date().toISOString(),
                fireDetected: false,
                sensorValues: [...simulatedSensors],
                message: 'Normal operation',
                isSimulation: true
            });
        }
    }, 2000);
}

// WebSocket connection handling
wss.on('connection', (ws) => {
    console.log('🔌 New WebSocket client connected');
    clients.push(ws);
    
    // Send initial connection status
    ws.send(JSON.stringify({
        type: 'connection',
        status: 'connected',
        arduinoConnected: arduinoConnected,
        message: 'Connected to APULA Arduino Server',
        timestamp: new Date().toISOString(),
        clientId: clients.length
    }));
    
    // Send current Arduino status
    if (arduinoConnected) {
        ws.send(JSON.stringify({
            type: 'arduino_status',
            status: 'connected',
            message: 'Arduino UNO connected',
            timestamp: new Date().toISOString()
        }));
    }
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            console.log('📨 Received from client:', data);
            
            // Handle commands from website
            if (data.command === 'test_arduino' && arduinoPort && arduinoConnected) {
                arduinoPort.write('TEST\n');
                ws.send(JSON.stringify({
                    type: 'command_response',
                    command: 'test',
                    message: 'Test command sent to Arduino',
                    timestamp: new Date().toISOString()
                }));
            }
            
            if (data.command === 'reconnect') {
                connectToArduino();
            }
            
            if (data.command === 'simulate_fire') {
                broadcastToClients({
                    type: 'fire_alert',
                    timestamp: new Date().toISOString(),
                    fireDetected: true,
                    location: 'Manual Test: Sensor 1 (D2)',
                    sensorValues: [0, 1, 1],
                    message: '🔥 MANUAL TEST: Fire detected!',
                    isTest: true
                });
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

// Broadcast to all connected clients
function broadcastToClients(data) {
    const message = JSON.stringify(data);
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// Start Arduino connection
connectToArduino();

console.log('🚀 WebSocket server ready on /arduino-ws');
