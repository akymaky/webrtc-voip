import fastify from "fastify"
import websocketPlugin from "@fastify/websocket"

const connections = []
const connMap = new Map()
const timeoutMap = new Map()

const getConn = username => connections.find(c => c.username === username)

const handlers = {
	login(ws, msg) {
		if (getConn(msg.username)) {
			ws.sendJSON({ error: { message: "Username is already logged in from another location." } })
			return
		}

		ws.username = msg.username
		connections.push(ws)
		ws.sendJSON({ login: { username: msg.username } })
	},
	call(ws, msg) {
		if (msg.username === ws.username) {
			ws.sendJSON({ end: { username: msg.username, reason: "You can't call yourself, silly!" } })
			return
		}

		if (connMap.has(msg.username)) {
			ws.sendJSON({ end: { username: msg.username, reason: "User is currently busy." } })
			return
		}

		const c = getConn(msg.username)
		if (!c) {
			ws.sendJSON({ end: { username: msg.username, reason: "User is offline or username is wrong." } })
			return
		}

		connMap.set(ws.username, c)
		c.sendJSON({ call: { username: ws.username, offer: msg.offer } })
		const timeout = setTimeout(() => {
			connMap.delete(ws.username)
			c.sendJSON({ cancel: { username: ws.username } })
			ws.sendJSON({ end: { username: msg.username, reason: "Timed out." } })
			timeoutMap.delete(ws.username)
		}, 10000)
		timeoutMap.set(ws.username, timeout)
	},
	cancel(ws, _) {
		const c = connMap.get(ws.username)
		const timeout = timeoutMap.get(ws.username)
		clearTimeout(timeout)
		timeoutMap.delete(ws.username)
		if (!c) return
		c.sendJSON({ cancel: { username: ws.username } })
	},
	end(ws, _) {
		if (connMap.has(ws.username)) {
			const c = connMap.get(ws.username)
			c.sendJSON({ end: { username: ws.username, reason: "Other user ended call." } })
			connMap.delete(c.username)
			connMap.delete(ws.username)
		}
	},
	answer(ws, msg) {
		const timeout = timeoutMap.get(msg.username)
		clearTimeout(timeout)
		const c = getConn(msg.username)
		connMap.set(ws.username, c)
		c.sendJSON({ answer: { username: ws.username, offer: msg.offer } })
	},
	reject(ws, msg) {
		const timeout = timeoutMap.get(msg.username)
		clearTimeout(timeout)
		timeoutMap.delete(msg.username)
		const me = connMap.get(msg.username)
		if (me && me.username === ws.username) {
			const c = getConn(msg.username)
			if (!c) return
			c.sendJSON({ reject: { username: ws.username } })
		}
	},
	ice(ws, msg) {
		const c = getConn(msg.username)
		c.sendJSON({ ice: { username: ws.username, candidate: msg.candidate } })
	}
}

const wsSendJSON = (ws, o) => ws.send(JSON.stringify(o))

const app = fastify()
app.register(websocketPlugin, { options: { maxPayload: 1048576 } })
app.register(async (app) => {
	app.get("/ws", { websocket: true }, (conn, req) => {
		conn.socket.sendJSON = wsSendJSON.bind(null, conn.socket)
		conn.socket.on("close", () => {
			if (!conn.socket.username) return
			const i = connections.findIndex(s => s.username === conn.socket.username)
			connections.splice(i, 1)
			const c = connMap.get(conn.socket.username)
			if (c) {
				c.sendJSON({ end: { username: conn.socket.username, reason: "User exited app" } })
				connMap.delete(c.username)
				connMap.delete(conn.socket.username)
			}
		})
		conn.socket.on("message", async message => {
			try {
				const msg = JSON.parse(message.toString())

				const h = handlers[msg.type]
				if (!h) {
					conn.socket.sendJSON({ error: "Invalid request made." })
					return
				}

				h(conn.socket, msg[msg.type])
			} catch (e) {
				console.error(e)
				conn.socket.sendJSON({ error: "Only JSON messages are supported!" })
			}
		})
	})
})

app.listen(5000, err => {
	if (err) {
		app.log.error(err)
		process.exit(1)
	}

	console.log("Listening on port 5000!")
})
