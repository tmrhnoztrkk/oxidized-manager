"""Tiny fake Cisco IOS device for end-to-end tests.

SSH on :22 (admin / cisco123) answers like IOS; the running-config contains a revision number
that can be changed through a control port: `echo 5 | nc DEVICE 9000`.
"""
import os
import socket
import threading

import paramiko

HOST = os.environ.get("HOSTNAME_PROMPT", "R1")
KEY = paramiko.RSAKey.generate(2048)
REV = {"n": 1}


def running():
    return (f"Building configuration...\n\nCurrent configuration : 200 bytes\n!\nversion 15.2\nhostname {HOST}\n!\n"
            f"interface GigabitEthernet0/0\n description uplink rev{REV['n']}\n ip address 10.0.0.1 255.255.255.0\n!\nend\n")


OUT = {"show version": "Cisco IOS Software, Version 15.2(4)M\nuptime is 1 week\n",
       "show inventory": 'NAME: "Chassis", DESCR: "Cisco 2901"\nPID: CISCO2901/K9 , VID: V01 , SN: FTX0000\n'}


class Server(paramiko.ServerInterface):
    def check_auth_password(self, u, p):
        return paramiko.AUTH_SUCCESSFUL if (u, p) == ("admin", "cisco123") else paramiko.AUTH_FAILED

    def get_allowed_auths(self, u):
        return "password"

    def check_channel_request(self, kind, cid):
        return paramiko.OPEN_SUCCEEDED

    def check_channel_pty_request(self, *a):
        return True

    def check_channel_shell_request(self, c):
        return True


def ssh_session(sock):
    t = paramiko.Transport(sock)
    t.add_server_key(KEY)
    t.start_server(server=Server())
    ch = t.accept(20)
    if not ch:
        return
    prompt = f"\r\n{HOST}#"
    ch.send(prompt)
    buf = b""
    while True:
        d = ch.recv(1024)
        if not d:
            break
        buf += d
        while b"\r" in buf or b"\n" in buf:
            i = min(x for x in (buf.find(b"\r"), buf.find(b"\n")) if x >= 0)
            cmd, buf = buf[:i].decode().strip(), buf[i + 1:]
            if cmd in ("exit", "quit"):
                ch.close()
                return
            if not cmd:
                continue
            out = running() if cmd.startswith("show run") else OUT.get(cmd, "")
            ch.send(cmd + "\r\n" + out.replace("\n", "\r\n") + prompt)


def control(sock):
    with sock:
        data = sock.recv(64).decode().strip()
        if data.isdigit():
            REV["n"] = int(data)
        sock.sendall(f"rev={REV['n']}\n".encode())


def serve(port, handler):
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("0.0.0.0", port))
    s.listen(20)
    while True:
        c, _ = s.accept()
        threading.Thread(target=handler, args=(c,), daemon=True).start()


threading.Thread(target=serve, args=(9000, control), daemon=True).start()
print(f"fake device {HOST} up", flush=True)
serve(22, ssh_session)
