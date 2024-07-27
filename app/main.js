import "./reset.css"
import "./style.css"

feather.replace()

const configuration = {
	iceServers: [
		{
			urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'],
		},
	],
	iceCandidatePoolSize: 10,
}

const micButton = document.querySelector("button[data-mic]")
const videoButton = document.querySelector("button[data-video]")

const localContainer = document.querySelector("[data-visualise='local']")
const localVideo = localContainer.querySelector("video[data-source='local']")
const localNoSignal = localContainer.querySelector("img")

const startSlot = document.querySelector("[data-slot='start']")

const popup = document.querySelector("dialog[data-popup]")

let pc, dataChannel

let localStream = new MediaStream()
let remoteStream = new MediaStream()

let myUsername

let micOn = false
let camOn = false

let cancelAnimationLocal, cancelAnimationRemote

function setupPC() {
	const prevPC = Boolean(pc)

	if (prevPC) {
		pc.close()
	}

	pc = new RTCPeerConnection(configuration)


	if (prevPC) {
		localStream.getTracks().forEach(track => {
			pc.addTrack(track, localStream)
		})
	}

	pc.ontrack = e => {
		remoteStream.addTrack(e.track)
		e.track.onended = _ => {
			remoteStream.removeTrack(e.track)
		}
	}

	pc.ondatachannel = e => {
		e.channel.onmessage = dcOnMessage
	}

	dataChannel = pc.createDataChannel("channel")

	dataChannel.onopen = () => {
		dataChannel.send(JSON.stringify({ mediaState: { mic: micOn, cam: camOn } }))
	}

	dataChannel.onmessage = dcOnMessage
}

setupPC()

async function getUserMedia() {
	return new Promise((resolve, reject) => {
		navigator.mediaDevices.getUserMedia({ audio: true, video: true })
			.then(stream => {
				stream.getTracks().forEach(track => {
					track.enabled = false
					localStream.addTrack(track)
					pc.addTrack(track, localStream)
				})
				localVideo.srcObject = localStream
				resolve(stream)
			})
			.catch(reject)
	})
}

void async function() {
	try {
		await getUserMedia()
	} catch (e) {
		if (e.name === "NotFoundError") {
			messagePopup("There are no micrphone/camera devices present. You won't be able to make full use of this app!")
		} else if (e.name === "NotAllowedError") {
			messagePopup("You have to grant microphone/camera permissions to be able to use this app!")
		} else {
			console.error(e)
			messagePopup("Unknown error occured. Refresh page and try again.")
		}
	}
}()

micButton.innerHTML = feather.icons["mic"].toSvg()
videoButton.innerHTML = feather.icons["video"].toSvg()

micButton.onclick = async () => {
	if (!localStream) {
		return
	}

	micButton.innerHTML = feather.icons[micOn ? "mic" : "mic-off"].toSvg()

	if (micOn) {
		cancelAnimationLocal()
	} else {
		cancelAnimationLocal = volumeMeter(localStream, localContainer)
	}

	localStream.getAudioTracks()[0].enabled = !micOn
	micOn = !micOn
	dataChannel && dataChannel.readyState === "open" && dataChannel.send(JSON.stringify({ mediaState: { mic: micOn } }))
}

videoButton.onclick = async () => {
	if (!localStream) {
		return
	}

	localNoSignal.classList.toggle("hidden")

	videoButton.innerHTML = feather.icons[camOn ? "video" : "video-off"].toSvg()

	localStream.getVideoTracks()[0].enabled = !camOn
	camOn = !camOn
	dataChannel && dataChannel.readyState === "open" && dataChannel.send(JSON.stringify({ mediaState: { cam: camOn } }))
}

const ws = new WebSocket("ws://localhost:5000/ws")
ws.onopen = () => {
	const template = document.querySelector("#login-template")
	const clone = template.content.cloneNode(true)
	const loginForm = clone.querySelector("form[action='login']")
	loginForm.onsubmit = e => {
		e.preventDefault()
		const formData = new FormData(e.target)
		ws.send(JSON.stringify({ type: "login", login: { username: formData.get("username") } }))
	}
	startSlot.innerHTML = ""
	startSlot.append(clone)
}

ws.onmessage = message => {
	const msg = JSON.parse(message.data)
	if (msg.login) {
		myUsername = msg.login.username
		callScreen(msg.login.username)
	} else if (msg.answer) {
		if (pc.currentRemoteDescription) return
		const answerDescription = new RTCSessionDescription(msg.answer.offer)
		pc.setRemoteDescription(answerDescription)
		startCall()
	} else if (msg.call) {
		callPopup(msg.call)
	} else if (msg.cancel) {
		popup.close()
		popup.innerHTML = ""
	} else if (msg.end) {
		setupPC()
		callScreen(myUsername)
		messagePopup(msg.end.reason)
	} else if (msg.reject) {
		messagePopup("Other user rejected call.")
	} else if (msg.ice) {
		if (!pc || !pc.currentRemoteDescription || !pc.signalingState === "closed") return
		const candidate = new RTCIceCandidate(msg.ice.candidate)
		pc.addIceCandidate(candidate)
	} else if (msg.error) {
		messagePopup("Error: " + msg.error.message)
	}
}

function callPopup(data) {
	const template = document.querySelector("#call-answer-popup")
	const clone = template.content.cloneNode(true)

	clone.querySelector("[data-slot='username']").textContent = data.username

	const answerBtn = clone.querySelector("button[data-action='answer']")
	const rejectBtn = clone.querySelector("button[data-action='reject']")

	answerBtn.onclick = async e => {
		pc.onicecandidate = e => {
			e.candidate && ws.send(JSON.stringify({ type:"ice", ice: { username: data.username, candidate: e.candidate.toJSON() } }))
		}

		const offerDescription = new RTCSessionDescription(data.offer)
		await pc.setRemoteDescription(offerDescription)

		const answerDescription = await pc.createAnswer()
		await pc.setLocalDescription(answerDescription)

		const offer = {
			sdp: answerDescription.sdp,
			type: answerDescription.type,
		}

		ws.send(JSON.stringify({ type:"answer", answer: { username: data.username, offer } }))

		startCall()
	}

	rejectBtn.onclick = e => {
		ws.send(JSON.stringify({ type:"reject", reject: { username: data.username } }))
	}

	popup.innerHTML = ""
	popup.appendChild(clone)
	feather.replace()
	!popup.open && popup.showModal()
}

function ringingPopup(username) {
	const form = document.createElement("form")
	const ringing = document.createElement("p")
	const hangUp = document.createElement("button")
	const text = document.createElement("p")

	form.method = "dialog"
	form.classList.add("flex", "column", "center")
	form.appendChild(hangUp)

	text.textContent = "Hang up"

	hangUp.classList.add("rounded", "flex", "center")
	hangUp.style.setProperty("--bg-colour", "red")
	hangUp.innerHTML = feather.icons["phone-off"].toSvg()
	hangUp.appendChild(text)
	hangUp.onclick = e => {
		ws.send(JSON.stringify({ type: "cancel", cancel: { username } }))
	}

	ringing.textContent = "Ringing"
	ringing.classList.add("loading")

	popup.innerHTML = ""
	popup.appendChild(ringing)
	popup.appendChild(form)
	!popup.open && popup.showModal()
}

function messagePopup(text) {
	popup.innerHTML = ""
	const message = document.createElement("p")
	message.textContent = text
	popup.appendChild(message)
	const closeBtn = document.createElement("button")
	closeBtn.onclick = e => popup.close()
	closeBtn.classList.add("rounded")
	closeBtn.style.setProperty("--bg-colour", "dimgrey")
	closeBtn.textContent = "Close"
	popup.appendChild(closeBtn)
	!popup.open && popup.showModal()
}

function startCall() {
	popup.close()
	const noSignal = document.createElement("img")
	const remoteVideo = document.createElement("video")
	const videoContainer = document.createElement("div")
	const container = document.createElement("div")

	container.classList.add("flex", "center")

	videoContainer.dataset.visualise = 'remote'
	videoContainer.classList.add("video-container")

	remoteVideo.dataset.source = "remote"
	remoteVideo.autoplay = true
	remoteVideo.playsInline = true
	remoteVideo.srcObject = remoteStream

	noSignal.src = "./no-signal.webp"

	videoContainer.appendChild(remoteVideo)
	videoContainer.appendChild(noSignal)

	container.appendChild(videoContainer)

	const buttons = document.createElement("div")
	const hangUp = document.createElement("button")
	const text = document.createElement("p")

	text.textContent = "Hang up"

	hangUp.classList.add("rounded", "flex", "center")
	hangUp.style.setProperty("--bg-colour", "red")
	hangUp.style.setProperty("--fg-colour", "white")
	hangUp.innerHTML = feather.icons["phone-off"].toSvg()
	hangUp.appendChild(text)
	hangUp.onclick = e => {
		ws.send(JSON.stringify({ type: "end" }))
		setupPC()
		callScreen(myUsername)
	}

	buttons.classList.add("flex", "center")
	buttons.appendChild(hangUp)

	startSlot.innerHTML = ""
	startSlot.appendChild(container)
	startSlot.appendChild(buttons)
}

function volumeMeter(stream, element) {

	const audioContext = new AudioContext()
	const analyser = audioContext.createAnalyser()
	analyser.fftSize = 2048

	const bufferLength = analyser.frequencyBinCount
	const dataArray = new Uint8Array(bufferLength)
	analyser.getByteFrequencyData(dataArray)

	const source = audioContext.createMediaStreamSource(stream)

	source.connect(analyser)

	element.style.setProperty("--outline-colour", "darkturquoise")

	let drawVisual

	function visualise() {
		drawVisual = requestAnimationFrame(visualise)
		analyser.getByteFrequencyData(dataArray)
		const avg = dataArray.reduce((a, b) => a + b, 0) / bufferLength
		const outlineWidth = Math.min(Math.max(avg / 250 * 100, 2), 10)
		element.style.setProperty("--outline-width", outlineWidth + "px")
	}

	visualise()

	return () => {
		element.style.removeProperty("--outline-width")
		element.style.removeProperty("--outline-colour")
		cancelAnimationFrame(drawVisual)
	}
}

function updateRemoteContainer(data) {
	const remoteContainer = document.querySelector("[data-visualise='remote']")

	if (data.mic === true) {
		cancelAnimationRemote = volumeMeter(remoteStream, remoteContainer)
	} else if (data.mic === false) {
		typeof cancelAnimationRemote === "function" && cancelAnimationRemote()
	}

	const noSignal = remoteContainer.querySelector("img")

	if (data.cam === true) {
		noSignal.classList.add("hidden")
	} else if (data.cam === false) {
		noSignal.classList.remove("hidden")
	}
}

function dcOnMessage({ data }) {
	const o = JSON.parse(data)
	o.mediaState && updateRemoteContainer(o.mediaState)
}

function callScreen(userUsername) {
	const template = document.querySelector("#call-template")
	const clone = template.content.cloneNode(true)

	const callForm = clone.querySelector("form[action='call']")
	callForm.onsubmit = async e => {
		e.preventDefault()
		const formData = new FormData(e.target)
		const username = formData.get("username")

		pc.onicecandidate = e => {
			e.candidate && ws.send(JSON.stringify({ type: "ice", ice: { username, candidate: e.candidate.toJSON() } }))
		}

		const options = { offerToReceiveAudio: true, offerToReceiveVideo: true }
		const offerDescription = await pc.createOffer(options)
		await pc.setLocalDescription(offerDescription)

		const offer = {
			sdp: offerDescription.sdp,
			type: offerDescription.type,
		}

		ws.send(JSON.stringify({ type: "call", call: { username, offer } }))
		ringingPopup(username)
	}

	const usernameSlot = clone.querySelector("[data-slot='username']")
	usernameSlot.textContent = userUsername
	startSlot.innerHTML = ""
	startSlot.appendChild(clone)
}
