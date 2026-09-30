"""Generated guest broker from packages/cloud-sdk/src/compat/shell.ts.

The contract test requires exact source equality across the two SDKs.
"""
SHELL_BROKER = r'''import base64, fcntl, json, os, select, selectors, shlex, signal, socket, subprocess, sys, time

root = sys.argv[2]
sockpath = os.path.join(root, 'socket')
statepath = os.path.join(root, 'state')

def send(conn, event):
    conn.sendall((json.dumps(event) + '\n').encode())

def stop_shell(shell):
    if shell is not None:
        try: os.killpg(shell.pid, signal.SIGKILL)
        except ProcessLookupError: pass
        shell.wait()

def server():
    os.umask(0o077)
    try: os.unlink(sockpath)
    except FileNotFoundError: pass
    listener = socket.socket(socket.AF_UNIX)
    listener.bind(sockpath)
    listener.listen(32)
    shell = None
    status_read = None
    baseline = {}
    try:
        while True:
            conn, _ = listener.accept()
            with conn:
                try:
                    data = b''
                    while not data.endswith(b'\n'):
                        chunk = conn.recv(65536)
                        if not chunk: raise ConnectionError('Client disconnected before command')
                        data += chunk
                        if len(data) > 16 * 1024 * 1024: raise ValueError('Shell request exceeds 16 MiB')
                    req = json.loads(data)
                    if select.select([conn], [], [], 0)[0] and not conn.recv(1, socket.MSG_PEEK):
                        raise ConnectionError('Client disconnected before execution')
                    if req.get('action') == 'destroy':
                        stop_shell(shell)
                        shell = None
                        send(conn, {'type':'exit', 'code':0})
                        return
                    if shell is None or shell.poll() is not None:
                        if status_read is not None: os.close(status_read)
                        status_read, status_write = os.pipe()
                        env = req['initialEnv']
                        shell = subprocess.Popen(['bash', '--noprofile', '--norc'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, cwd=req['initialCwd'], pass_fds=(status_write,), start_new_session=True)
                        baseline = req['baseEnv']
                        shell.stdin.write(b'shopt -s expand_aliases\n')
                        # Export/cwd snapshots allow upgrades and background processes to reconnect.
                        if os.path.exists(statepath):
                            shell.stdin.write(('builtin source ' + shlex.quote(statepath) + '\n').encode())
                        os.close(status_write)
                    lines = ['builtin unset -- ' + shlex.quote(key) for key in baseline if key not in req['baseEnv']]
                    for key, value in req['baseEnv'].items():
                        if baseline.get(key) != value: lines.append('builtin export -- ' + shlex.quote(key + '=' + value))
                    baseline = req['baseEnv']
                    for key, value in req['env'].items(): lines.append('builtin export -- ' + shlex.quote(key + '=' + value))
                    if req.get('cwd'): lines.append('builtin cd -- ' + shlex.quote(req['cwd']) + ' &&')
                    commandpath = os.path.join(root, 'command')
                    with open(commandpath, 'w') as source: source.write(req['command'] + '\n')
                    lines.append('builtin source ' + shlex.quote(commandpath))
                    # All bookkeeping happens after evaluation. No shell variables can
                    # overwrite the requested command before it runs.
                    script = '\n'.join(lines) + '\n__runtime_status=$?\n'
                    script += '(builtin umask 077; builtin export -p | /usr/bin/sed "/^declare -x __runtime_/d" > ' + shlex.quote(statepath + '.next') + '; builtin printf "cd -- %q\\n" "$PWD" >> ' + shlex.quote(statepath + '.next') + '; /bin/mv -- ' + shlex.quote(statepath + '.next') + ' ' + shlex.quote(statepath) + ')\n'
                    script += '(umask 077; builtin printf "%s" "$PWD" >| ' + shlex.quote(os.path.join(root, 'cwd')) + ')\n'
                    script += 'builtin printf "%s\\n" "$__runtime_status" >&' + str(status_write) + '\n'
                    shell.stdin.write(script.encode())
                    shell.stdin.flush()
                    status = b''
                    with selectors.DefaultSelector() as sel:
                        sel.register(shell.stdout, selectors.EVENT_READ, 'stdout')
                        sel.register(shell.stderr, selectors.EVENT_READ, 'stderr')
                        sel.register(status_read, selectors.EVENT_READ, 'status')
                        sel.register(conn, selectors.EVENT_READ, 'client')
                        while True:
                            events = sel.select(0.1)
                            # Drain output before acknowledging completion, even when
                            # the completion pipe and output become readable together.
                            for key, _ in sorted(events, key=lambda event: event[0].data == 'status'):
                                kind = key.data
                                if kind == 'client':
                                    if not conn.recv(1, socket.MSG_PEEK): raise ConnectionError('Client disconnected')
                                    continue
                                chunk = os.read(key.fd, 65536)
                                if not chunk:
                                    sel.unregister(key.fileobj)
                                    continue
                                if kind == 'status': status += chunk
                                else: send(conn, {'type':kind, 'base64':base64.b64encode(chunk).decode()})
                            if b'\n' in status:
                                # Pipe readiness can race: exhaust currently buffered output.
                                for pipe, kind in [(shell.stdout,'stdout'),(shell.stderr,'stderr')]:
                                    os.set_blocking(pipe.fileno(), False)
                                    try:
                                        while True:
                                            chunk = os.read(pipe.fileno(), 65536)
                                            if not chunk: break
                                            send(conn, {'type':kind,'base64':base64.b64encode(chunk).decode()})
                                    except BlockingIOError: pass
                                    finally: os.set_blocking(pipe.fileno(), True)
                                send(conn, {'type':'exit','code':int(status.split(b'\n')[0])})
                                break
                            if shell.poll() is not None:
                                # A terminated shell starts fresh next time, not from old exports.
                                for stale in (statepath, os.path.join(root, 'cwd')):
                                    try: os.unlink(stale)
                                    except FileNotFoundError: pass
                                send(conn, {'type':'exit','code':shell.returncode if shell.returncode >= 0 else 128-shell.returncode, 'terminated':True})
                                break
                except (BrokenPipeError, ConnectionError, OSError):
                    stop_shell(shell)
                    shell = None
                except Exception as error:
                    stop_shell(shell)
                    shell = None
                    try: send(conn, {'type':'error','message':str(error)})
                    except OSError: pass
    finally:
        stop_shell(shell)
        listener.close()
        try: os.unlink(sockpath)
        except FileNotFoundError: pass

if sys.argv[1] == 'server':
    server()
else:
    os.makedirs(root, mode=0o700, exist_ok=True)
    conn = socket.socket(socket.AF_UNIX)
    with open(os.path.join(root, 'startup.lock'), 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try: conn.connect(sockpath)
        except (FileNotFoundError, ConnectionRefusedError):
            if json.loads(sys.argv[3]).get('action') == 'destroy': sys.exit(0)
            with open(os.path.join(root, 'startup.log'), 'wb') as log:
                daemon = subprocess.Popen([sys.executable, __file__, 'server', root], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=log, start_new_session=True)
            for _ in range(300):
                try:
                    conn.connect(sockpath)
                    break
                except (FileNotFoundError, ConnectionRefusedError):
                    if daemon.poll() is not None:
                        with open(os.path.join(root, 'startup.log')) as log: raise RuntimeError('Resident shell startup: ' + log.read())
                    time.sleep(0.01)
            else: raise RuntimeError('Resident shell failed to start')
    with conn:
        req = json.loads(sys.argv[3])
        req['initialEnv'] = dict(os.environ)
        req['initialCwd'] = os.getcwd()
        send(conn, req)
        for line in conn.makefile('rb'):
            event = json.loads(line)
            if event['type'] == 'exit': sys.exit(event['code'])
            if event['type'] == 'error': raise RuntimeError(event['message'])
            target = sys.stdout.buffer if event['type'] == 'stdout' else sys.stderr.buffer
            target.write(base64.b64decode(event['base64']))
            target.flush()
        raise RuntimeError('Resident shell disconnected without exit status')
'''
