# Real-Time Sync Media Server (YouTube + Local Video + Local Audio + PPTX)
⚠️ **Note:** This repository contains an **older version** of the project.  
For the **latest version and updated setup guide**, please visit the **documentation**
📄 https://rmsdocs.netlify.app/

This is a simple, self-hosted Node.js server designed to synchronize YouTube video, Local Video, Local Audio and PPTX Presentation playback across multiple clients on a local network 🏠. It's perfect for creating a shared viewing experience where one person can control the media (play, pause, seek, load, navigate slides) for everyone else, all in real-time.

It features a web-based controller that generates QR codes 📱 for easy connection to your WiFi hotspot and for accessing the client/controller pages.

---

## 🚀 Features

* **YouTube Sync:** Load any YouTube video using its URL or 11-character ID.
* **Local Video Support:** Upload your own video files from the controller device. Files automatically get hosted and synced across clients.
* **Local Audio Support:** Upload MP3/WAV audio files and play them in sync across all clients.
* **PPTX Presentation Sync:** Upload PowerPoint presentations and sync slide navigation, zoom, and annotations in real-time.
  * Navigate between slides (Previous/Next/Go to specific slide)
  * Zoom controls (50%, 75%, 100%, 150%, 200%)
  * Drawing tools with color and width options
  * Laser pointer for highlighting
  * Clear annotations
* **Core Controls:** Supports **Play** ▶️, **Pause** ⏸️, **Seek** ⏩, and **Restart** ⏮️.
* **Easy Setup:** Uses a simple `config.json` file to manage WiFi credentials.
* **QR Code Access:**
    * Generates a QR code for your WiFi hotspot so clients can connect easily.
    * Generates QR codes for both the `controller.html` and `client.html` pages.
* **Status Dashboard:** The controller page shows a live count of connected clients 👥.

---

## 🛠️ Tech Stack

* **Server:** Node.js, Express, Socket.io
* **Client:** HTML, CSS, JavaScript (Socket.io client)
* **Utilities:** `qrcode` (for generating QR codes)

---

## 📦 Prerequisites

* [Node.js](https://nodejs.org/) (which includes npm)
* A local WiFi network or mobile hotspot 📶 that all your devices can connect to.

---

## ⚙️ Installation & Setup

1.  **Download Files:**
    Download the project files (`server.js`, `package.json`, etc.) and place them in a new directory 📁.

2.  **Create `public` folder:**
    You must create a folder named `public` and place your `controller.html` and `client.html` files inside it.

    ```
    /your-project
    ├── node_modules/
    ├── uploads/  
    ├── public/
    │   ├── client.html      <-- The video player page 💻
    │   └── controller.html  <-- The remote control page 📱
    ├── config.json
    ├── package.json
    └── server.js
    ```

3.  **Install Dependencies:**
    Open a terminal in the project directory and run:
    ```sh
    npm install
    ```
    This will install `express`, `socket.io`, `qrcode`, and other necessary packages.

4.  **Configure WiFi:**
    Create a file named `config.json` in the same directory as `server.js`. This is where you will set the WiFi credentials that the server will share via QR code.

    **`config.json`**
    ```json
    {
      "WIFI_SSID": "Your_Hotspot_Name",
      "WIFI_PASSWORD": "Your_Hotspot_Password",
      "HOTSPOT_IP": "Your_IP"
    }
    ```

    To Find Your Hotspot IP Address
    
    **`Open Command Prompt & Run`**
    ```sh
    ipconfig
    ```

---

## ▶️ How to Use

1.  **Start the Server:**
    Run the server from your terminal:
    ```sh
    node server.js
    ```
    A banner will appear in your console showing the server's IP address, port, and the URLs for the controller and client pages.

    ```
    ══════════════════════════════════════════════════════════════════════
      MULTI-MEDIA SYNC SERVER
    ══════════════════════════════════════════════════════════════════════
      Status:       Running
      Local Time:   7/12/2025, 10:06:41 pm
      Server IP:    0.0.0.0 (Manual: true)
      Port:         8000
   
      WiFi Network: KALE KALE
      Password:     Priyank@1602
   
      Controller URL:
      http://0.0.0.0:8000/controller.html
   
      Client URL:
      http://0.0.0.0:8000/client.html

      Supports: YouTube Videos | Local Videos | Local Audio
    ══════════════════════════════════════════════════════════════════════
      Waiting for connections...
    ```
    You should either copy the URL from your terminal or scan the QR code.

2.  **Connect Devices:**
    * On your "controller" device (e.g., your phone), open a browser and go to the **Controller URL** printed in the terminal.
    * On your "viewer" devices (e.g., laptops, tablets), connect them to the WiFi hotspot. You can use the "WiFi Connection" QR code on the controller page for this.
    * Once connected, have the viewer devices open the **Client URL**.

3.  **Control Playback:**
    * You should see the "Connected Clients" count increase on the controller page.
    * Paste a YouTube URL or Video ID into the input box on the controller page and click "Load Video".
    * Use the Play, Pause, and Seek buttons to control all connected clients at once. Enjoy the show! 🍿

---

## 🐛 Troubleshooting

### ❗ Clients Not Syncing?

Try the following steps:

1. Enter a time (in seconds) into the **Seek** box.  
2. Press **Seek**.  
3. Repeat the Seek command **1–2 times** if needed (helps reduce buffering lag).

### ❗ Video Not Loading?

Check the following:

- Ensure the **server IP address** is correct.  
- Make sure all devices are connected to the **same WiFi/hotspot**.  
- Verify the **file format** is supported by the browser (e.g., MP4/WebM for video, MP3/WAV for audio).  

