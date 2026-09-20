const wasm = await import('./wasm-lib/CavalryWasm.js')

const Module = await wasm.default({
    locateFile: (path) => `./wasm-lib/${path}`,
    print: (text) => console.log(text),
    printErr: (text) => console.error(text),
})

const response = await fetch('./scene.cv')
const sceneData = await response.arrayBuffer()

Module.FS.writeFile(
    'scene.cv',
    new Uint8Array(sceneData)
)

const player = Module.Cavalry.MakeWithPath('scene.cv')

const scene = player.getSceneResolution()

const canvas = document.getElementById('canvas')


// ----------------------------------------
// Set the canvas to the Cavalry resolution
// ----------------------------------------

canvas.width = scene.width
canvas.height = scene.height


// ----------------------------------------
// Create Cavalry WebGL surface
// ----------------------------------------

const surface = Module.makeWebGLSurfaceFromElement(
    canvas,
    scene.width,
    scene.height
)


// ----------------------------------------
// Fit canvas inside browser window
// ----------------------------------------

function resizeCanvas() {

    const windowWidth = window.innerWidth
    const windowHeight = window.innerHeight

    const sceneRatio = scene.width / scene.height
    const windowRatio = windowWidth / windowHeight

    let width
    let height

    if (windowRatio > sceneRatio) {

        // Window is wider than the scene
        height = windowHeight
        width = height * sceneRatio

    } else {

        // Window is taller than the scene
        width = windowWidth
        height = width / sceneRatio

    }

    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`

    // Center the canvas
    canvas.style.position = 'absolute'
    canvas.style.left = `${(windowWidth - width) / 2}px`
    canvas.style.top = `${(windowHeight - height) / 2}px`
}


// Resize initially
resizeCanvas()

// Resize when browser changes size
window.addEventListener('resize', resizeCanvas)


// ----------------------------------------
// Render
// ----------------------------------------

player.render(surface)


// ----------------------------------------
// Animation
// ----------------------------------------

const tick = (timestamp) => {

    player.tick(surface, timestamp)

    requestAnimationFrame(tick)
}

requestAnimationFrame(tick)

player.play()


// ----------------------------------------------------------------
// External control bridge (Framer, or any parent page)
// ----------------------------------------------------------------
//
// This listens for postMessage calls from the parent page (e.g. a
// Framer iframe embed) and forwards them into the Cavalry player's
// own API. There is no per-control code to maintain here — to wire
// up a *new* attribute control in Framer later, you don't need to
// touch this file at all.
//
// Message types handled:
//   { type: 'setAttribute', path: 'layerId.attrId', value: any }
//   { type: 'play' }
//   { type: 'pause' }
//   { type: 'seek', time: <seconds> }
//   { type: 'export', kind: 'png' | 'video', requestId: <number> }

function applyAttribute(layerId, attrId, value) {
    try {
        player.setAttribute(layerId, attrId, value)
        player.render(surface)
    } catch (err) {
        console.error(`[Cavalry bridge] Failed to set "${layerId}.${attrId}" to`, value, err)
    }
}

function getControlCentreAttributes() {
    try {
        return player.getControlCentreAttributes(player.getActiveComp())
    } catch (err) {
        console.warn('[Cavalry bridge] Could not read Control Centre attributes:', err)
        return []
    }
}

// ----------------------------------------------------------------
// Play / Pause / Seek
// ----------------------------------------------------------------
// Cavalry's player has no separate "pause" method - stop() halts
// playback and keeps the current frame, which is exactly pause
// behaviour. Seeking works in FRAMES, not seconds, so we convert
// using the scene's FPS.

function handlePlay() {
    player.play()
}

function handlePause() {
    player.stop()
}

function handleSeek(seconds) {
    const fps = player.getFPS()
    const frame = Math.round((seconds || 0) * fps)

    // Per Cavalry's docs: stop playback before setting the frame,
    // then resume afterwards if it was already playing.
    const wasPlaying = player.isPlaying()
    player.stop()
    player.setFrame(frame)
    player.render(surface)
    if (wasPlaying) player.play()
}

// ----------------------------------------------------------------
// Export (current frame PNG / whole sequence video)
// ----------------------------------------------------------------
// The download happens right here, inside this page (the Cavalry
// embed) - not in Framer - since this is the page that actually
// has access to the canvas. Framer is just told when it's done.
//
// PNG export uses the canvas directly. Video export uses the
// browser's built-in MediaRecorder to capture a real-time playback
// pass, since Cavalry's API doesn't expose a video export method
// itself. This produces a .webm file — note MediaRecorder/WebM
// support is inconsistent in Safari, so video export may only work
// reliably in Chrome/Edge/Firefox.

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function exportCurrentFramePng() {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (blob) resolve(blob)
            else reject(new Error('canvas.toBlob returned null'))
        }, 'image/png')
    })
}

async function exportSequenceVideo(requestId) {
    if (typeof VideoEncoder === 'undefined') {
        throw new Error(
            'MP4 export needs the WebCodecs API, which this browser does not support. Chrome, Edge, and Safari 16.4+ all work.'
        )
    }

    // Loaded from a CDN at export time, so it only needs an internet
    // connection in the VISITOR's browser - nothing to install here.
    const { Muxer, ArrayBufferTarget } = await import(
        'https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.1/build/mp4-muxer.mjs'
    )

    const fps = Math.round(player.getFPS())
    const startFrame = player.getStartFrame()
    const endFrame = player.getEndFrame()
    const width = canvas.width
    const height = canvas.height

    const wasPlaying = player.isPlaying()
    const wasLooping = player.isLooping()
    player.setLoop(false)
    player.stop()

    // Pick the highest-quality H.264 profile/level this browser will
    // actually support at the scene's real resolution, so we're never
    // silently downgraded to a lower-res-capable profile.
    const codecCandidates = [
        'avc1.640033', // High @ 5.1 - up to ~4K
        'avc1.640028', // High @ 4.0 - up to ~1080p
        'avc1.4d0028', // Main @ 4.0
        'avc1.42001f', // Baseline @ 3.1 - most widely supported
    ]

    const bitrate = 10_000_000 // 10 Mbps - high quality at full resolution
    let chosenCodec = null

    for (const codec of codecCandidates) {
        const support = await VideoEncoder.isConfigSupported({
            codec,
            width,
            height,
            bitrate,
            framerate: fps,
            hardwareAcceleration: 'prefer-hardware',
        })
        if (support.supported) {
            chosenCodec = codec
            break
        }
    }

    if (!chosenCodec) {
        throw new Error(
            `No supported H.264 configuration found for ${width}x${height} in this browser.`
        )
    }

    const muxer = new Muxer({
        target: new ArrayBufferTarget(),
        video: { codec: 'avc', width, height },
        fastStart: 'in-memory',
    })

    const videoEncoder = new VideoEncoder({
        output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
        error: (err) => console.error('[Cavalry bridge] VideoEncoder error:', err),
    })

    videoEncoder.configure({
        codec: chosenCodec,
        width,
        height,
        bitrate,
        framerate: fps,
        // Ask for the machine's dedicated video-encoding hardware when
        // available - much faster than software encoding, at the same
        // quality. Falls back to software automatically if unavailable.
        hardwareAcceleration: 'prefer-hardware',
    })

    const frameDurationUs = Math.round(1_000_000 / fps)
    const totalFrames = endFrame - startFrame + 1
    let lastReportedProgress = -1

    // Step through every frame exactly, rendering and encoding each one -
    // not tied to real-time playback, so nothing is dropped or rushed
    // regardless of how fast/slow this machine renders.
    for (let frame = startFrame; frame <= endFrame; frame++) {
        player.setFrame(frame)
        player.render(surface)

        // Read the canvas directly - no extra copy needed before encoding.
        const videoFrame = new VideoFrame(canvas, {
            timestamp: (frame - startFrame) * frameDurationUs,
            duration: frameDurationUs,
        })

        // Let encoding run in the background while the next frame renders,
        // only pausing if the encoder's internal queue is falling behind
        // (keeps memory bounded without forcing one-at-a-time processing).
        if (videoEncoder.encodeQueueSize > 2) {
            await new Promise((resolve) =>
                videoEncoder.addEventListener('dequeue', resolve, { once: true })
            )
        }

        videoEncoder.encode(videoFrame)
        videoFrame.close()

        // Report progress back to Framer, throttled to roughly every 1%
        // so we're not flooding postMessage on long sequences.
        const progress = (frame - startFrame + 1) / totalFrames
        if (progress - lastReportedProgress >= 0.01 || frame === endFrame) {
            lastReportedProgress = progress
            window.parent.postMessage(
                { type: 'exportProgress', requestId, kind: 'video', progress },
                '*'
            )
        }
    }

    await videoEncoder.flush()
    muxer.finalize()

    const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' })

    // Restore playback to how it was before exporting.
    player.setLoop(wasLooping)
    player.setFrame(startFrame)
    player.render(surface)
    if (wasPlaying) player.play()

    return blob
}

async function handleExport(kind, requestId) {
    try {
        const blob =
            kind === 'video'
                ? await exportSequenceVideo(requestId)
                : await exportCurrentFramePng()

        const filename = kind === 'video' ? 'sequence.mp4' : 'frame.png'
        downloadBlob(blob, filename)

        window.parent.postMessage(
            { type: 'exportResult', requestId, success: true },
            '*'
        )
    } catch (err) {
        console.error('[Cavalry bridge] Export failed:', err)
        window.parent.postMessage(
            { type: 'exportResult', requestId, error: String(err) },
            '*'
        )
    }
}

window.addEventListener('message', (event) => {

    const data = event.data

    if (!data || !data.type) return

    if (data.type === 'setAttribute') {
        let layerId = data.layerId
        let attrId = data.attrId

        // Convenience: allow a single "layerId.attrId" path instead of
        // two separate fields. Only split on the FIRST dot, since some
        // attrIds are themselves compound (e.g. "material.materialColor").
        if (data.path) {
            const dotIndex = data.path.indexOf('.')
            layerId = data.path.slice(0, dotIndex)
            attrId = data.path.slice(dotIndex + 1)
        }

        if (!layerId || !attrId) {
            console.warn('[Cavalry bridge] setAttribute message missing layerId/attrId:', data)
            return
        }

        applyAttribute(layerId, attrId, data.value)
        return
    }

    if (data.type === 'play') {
        handlePlay()
        return
    }

    if (data.type === 'pause') {
        handlePause()
        return
    }

    if (data.type === 'seek') {
        handleSeek(data.time)
        return
    }

    if (data.type === 'export') {
        handleExport(data.kind, data.requestId)
        return
    }

    if (data.type === 'replaceImageAsset') {
        try {
            const bytes = new Uint8Array(data.data)
            Module.FS.writeFile(data.fileName, bytes)
            player.replaceImageAsset(data.fileName, data.assetId)
            player.render(surface)
        } catch (err) {
            console.error('[Cavalry bridge] Failed to replace image asset:', err)
        }
        return
    }
})

// Print out every attribute you've exposed via Cavalry's Control
// Centre, so you can see exactly which "layerId.attrId" paths are
// available to wire up in Framer, straight from devtools.
const controlCentreAttributes = getControlCentreAttributes()
console.log('[Cavalry bridge] Available Control Centre attributes:', controlCentreAttributes)

// Print out any assets (images, fonts, etc.) the scene knows about, so
// you can find the correct assetId to use for an image upload control.
console.log('[Cavalry bridge] Scene assets (look here for assetId values):', Module.pendingAssets)

// Let the parent page (Framer) know the player is ready, and hand it
// the same attribute list, in case it wants to build UI dynamically.
window.parent.postMessage({
    type: 'cavalryReady',
    controlCentreAttributes,
}, '*')
