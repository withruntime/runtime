import type { Sandbox, Process } from "../sandbox.js";

const root = "/workspace/.runtime-compat/codesandbox/service";
export const taskServiceSource = String.raw`import base64,errno,fcntl,json,os,pty,select,signal,socket,socketserver,struct,subprocess,sys,termios,threading,time,uuid
root=sys.argv[1]
os.makedirs(root,mode=0o700,exist_ok=True)
os.umask(0o077)
lock=open(os.path.join(root,'lock'),'a')
try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
except BlockingIOError: sys.exit(0)
mutex=threading.RLock()
runs={}
current={}
boot_state={'state':'starting'}
def atomic(path,data):
 temp=path+'.tmp'
 with open(temp,'w') as f: json.dump(data,f)
 os.replace(temp,path)
def identity(pid):
 try:
  with open('/proc/'+str(pid)+'/stat') as f: return f.read().rsplit(')',1)[1].split()[19]
 except FileNotFoundError: return None
def record(run):
 with run['_lock']: return {k:v for k,v in run.items() if k not in ('process','fd','writer','_lock')}
def save(run):
 value=record(run)
 value.pop('inputWriters',None)
 atomic(os.path.join(root,run['id']+'.json'),value)
def settled(run):
 try: save(run)
 except OSError as e:
  # Keep terminal failure readable over the socket even when storage is full.
  run['exitCode']=125
  run['error']=(run.get('error','')+'; ' if run.get('error') else '')+'Cannot persist task result: '+str(e)
def complete(run):
 fd=run['fd']
 failed=False
 try:
  with open(os.path.join(root,run['id']+'.log'),'ab',buffering=0) as out:
   while True:
    ready,_,_=select.select([fd],[],[],0.05)
    if not ready:
     if run['process'].poll() is not None: break
     continue
    try: data=os.read(fd,65536)
    except OSError as e:
     if e.errno==errno.EIO: break
     raise
    if not data: break
    out.write(data)
 except BaseException as e:
  failed=True
  with run['_lock']: run['error']=str(e)
  try: os.killpg(run['process'].pid,signal.SIGKILL)
  except ProcessLookupError: pass
 finally:
  code=run['process'].wait()
  with run['_lock']:
   try: os.close(fd)
   except OSError: pass
   run['fd']=None
   run['exitCode']=125 if failed else code
   run['state']='exited'
   settled(run)
def stop(run):
 if run.get('state')!='running': return
 proc=run.get('process')
 if proc is not None and proc.poll() is None:
  try: os.killpg(proc.pid,signal.SIGTERM)
  except ProcessLookupError: pass
  try: proc.wait(timeout=2)
  except subprocess.TimeoutExpired:
   try: os.killpg(proc.pid,signal.SIGKILL)
   except ProcessLookupError: pass
   proc.wait()
 elif proc is None and run.get('pid') and run.get('identity') and identity(run['pid'])==run['identity']:
  # On supervisor recovery, fence against PID reuse before touching a process.
  try: os.killpg(run['pid'],signal.SIGKILL)
  except ProcessLookupError: pass
 if proc is not None and run.get('writer'):
  run['writer'].join(timeout=3)
  if run['writer'].is_alive(): raise TimeoutError('Task output did not finish after stop')
 if proc is None:
  run['state']='exited'
  run['exitCode']=-signal.SIGKILL
  settled(run)
def config():
 with open(os.path.join(root,'config.json')) as f: return json.load(f)
def start(task):
 cfg=config()
 definition=cfg['tasks'].get(task)
 if definition is None: raise ValueError('No such task')
 old=current.get(task)
 if old is not None: stop(runs[old])
 master,slave=pty.openpty()
 fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,128,0,0))
 try:
  proc=subprocess.Popen(['bash','-c',definition['command']],cwd=cfg['cwd'],env=dict(os.environ,**cfg.get('env',{})),stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
 except BaseException:
  os.close(master)
  raise
 finally: os.close(slave)
 run={'id':str(uuid.uuid4()),'taskId':task,'pid':proc.pid,'identity':identity(proc.pid),'state':'running','exitCode':None,'command':definition['command'],'startedAt':time.time()*1000,'process':proc,'fd':master,'_lock':threading.RLock()}
 runs[run['id']]=run
 current[task]=run['id']
 try:
  save(run)
  atomic(os.path.join(root,'current.json'),current)
 except BaseException:
  try: os.killpg(proc.pid,signal.SIGKILL)
  except ProcessLookupError: pass
  proc.wait()
  os.close(master)
  runs.pop(run['id'],None)
  if old is None: current.pop(task,None)
  else: current[task]=old
  raise
 run['writer']=threading.Thread(target=complete,args=(run,),daemon=True)
 run['writer'].start()
 return record(run)
def write(req):
 data=base64.b64decode(req['data'],validate=True)
 with mutex:
  run=runs.get(req['id'])
  if run is None: raise ValueError('Task is not running')
  # Own this open file description across close/restart; never reuse a raw FD.
  with run['_lock']:
   if run['state']!='running': raise ValueError('Task is not running')
   fd=os.dup(run['fd'])
   run['inputWriters']=run.get('inputWriters',0)+1
 try:
  os.set_blocking(fd,False)
  deadline=time.monotonic()+5
  while data:
   with mutex:
    if run['state']!='running': raise ValueError('Task is not running')
   remaining=deadline-time.monotonic()
   if remaining<=0: raise TimeoutError('Task input write timed out')
   _,ready,_=select.select([],[fd],[],min(remaining,0.1))
   if not ready: continue
   try: sent=os.write(fd,data)
   except BlockingIOError: continue
   data=data[sent:]
 finally:
  os.close(fd)
  with run['_lock']: run['inputWriters']-=1
def read(req):
 with mutex:
  run=runs.get(req['id'])
  if run is None: raise ValueError('No such task run')
 offset=req.get('offset',0)
 deadline=time.monotonic()+min(max(req.get('waitMs',0),0),2000)/1000
 while True:
  # Observe terminal status before reading: exited guarantees logs are drained.
  snapshot=record(run)
  try:
   with open(os.path.join(root,run['id']+'.log'),'rb') as f:
    size=os.fstat(f.fileno()).st_size
    f.seek(offset); data=f.read(min(65536,max(0,req.get('until',size)-offset)))
  except FileNotFoundError: data=b''; size=0
  if data or snapshot['state']!='running' or time.monotonic()>=deadline:
   return dict(snapshot,data=base64.b64encode(data).decode(),offset=offset+len(data),size=size)
  time.sleep(0.02)
def handle(req):
 if req['op']=='write': return write(req)
 if req['op']=='read': return read(req)
 with mutex:
  op=req['op']
  if op=='ping': return {'ok':True}
  if op=='boot': return dict(boot_state)
  if op=='list': return [record(runs[id]) for id in current.values() if id in runs]
  if op=='get':
   id=current.get(req['taskId'])
   return record(runs[id]) if id is not None else None
  if op=='start': return start(req['taskId'])
  if op=='stopTask':
   id=current.get(req['taskId'])
   if id is None: return None
   stop(runs[id]); return record(runs[id])
  run=runs.get(req['id'])
  if run is None: raise ValueError('No such task run')
  if op=='stop': stop(run); return record(run)
  if op=='resize':
   with run['_lock']:
    if run['state']=='running': fcntl.ioctl(run['fd'],termios.TIOCSWINSZ,struct.pack('HHHH',req['rows'],req['cols'],0,0))
   return None
  raise ValueError('Unknown operation')
# A restarted service never assumes a recorded PID still belongs to it.
try:
 with open(os.path.join(root,'current.json')) as f: current=json.load(f)
except FileNotFoundError: pass
for id in list(current.values()):
 try:
  with open(os.path.join(root,id+'.json')) as f: run=json.load(f)
  run['_lock']=threading.RLock()
  stop(run)
  runs[id]=run
 except FileNotFoundError: pass
class Handler(socketserver.StreamRequestHandler):
 def handle(self):
  try:
   line=self.rfile.readline(1048577)
   if len(line)>1048576: raise ValueError('Request too large')
   result={'ok':True,'value':handle(json.loads(line))}
  except Exception as e: result={'ok':False,'error':str(e)}
  try: self.wfile.write(json.dumps(result).encode()+b'\n')
  except (BrokenPipeError,ConnectionResetError): pass # The SDK detached its request.
class Server(socketserver.ThreadingUnixStreamServer): daemon_threads=True
path=os.path.join(root,'socket')
boot_state['config']=config().get('setup',{}).get('config')
try: os.unlink(path)
except FileNotFoundError: pass
server=Server(path,Handler)
def shutdown(signum,frame):
 with mutex:
  for run in runs.values(): stop(run)
 os._exit(128+signum)
signal.signal(signal.SIGTERM,shutdown)
signal.signal(signal.SIGINT,shutdown)
def boot():
 cfg=config()
 setup=cfg.get('setup')
 with mutex: boot_state['config']=setup.get('config') if setup else None
 if setup and setup['steps']:
  setup_root=os.path.join(os.path.dirname(root),'setup')
  os.makedirs(setup_root,mode=0o700,exist_ok=True)
  progress=os.path.join(setup_root,'progress.json')
  try:
   with open(progress) as f: previous=json.load(f)
  except FileNotFoundError: previous={}
  if previous.get('config')!=setup['config'] or previous.get('state')!='FINISHED':
   run=dict(setup,runId=str(uuid.uuid4()),cwd=cfg['cwd'])
   path=os.path.join(setup_root,run['runId']+'.json')
   atomic(path,run)
   result=subprocess.run([sys.executable,os.path.join(root,'setup.py'),path],env=dict(os.environ,**cfg.get('env',{})),capture_output=True,text=True)
   if result.returncode!=0: raise RuntimeError(result.stderr.strip() or 'Setup exited with code '+str(result.returncode))
   while True:
    try:
     with open(progress) as f: result=json.load(f)
    except FileNotFoundError: return
    if result.get('state')!='IN_PROGRESS': break
    time.sleep(0.1)
   if result.get('state')!='FINISHED' or result.get('config')!=setup['config']: return
 # The service owns automatic tasks independently of SDK connections.
 with mutex:
  for task,definition in cfg['tasks'].items():
   if definition.get('runAtStart'):
    try: start(task)
    except Exception as e:
     # A failed automatic launch must remain observable even if storage is full.
     run={'id':str(uuid.uuid4()),'taskId':task,'state':'exited','exitCode':125,'command':definition['command'],'startedAt':time.time()*1000,'error':'Automatic task startup failed: '+str(e),'_lock':threading.RLock()}
     runs[run['id']]=run
     current[task]=run['id']
     settled(run)
     try: atomic(os.path.join(root,'current.json'),current)
     except OSError: pass
def boot_guard():
 try:
  boot()
  with mutex: boot_state['state']='ready'
 except Exception as e:
  with mutex: boot_state.update(state='failed',error='Task setup startup failed: '+str(e))
threading.Thread(target=boot_guard,daemon=True).start()
server.serve_forever()
`;
const requestSource = String.raw`import json,socket,sys
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
s.settimeout(10)
s.connect(sys.argv[1]+'/socket')
s.sendall(sys.stdin.buffer.read()+b'\n')
f=s.makefile('rb')
try: print(f.readline(1048576).decode(),end='')
finally: f.close(); s.close()
`;
const installSource = String.raw`import os,subprocess,sys
root=sys.argv[1]
unit='''[Unit]
Description=Runtime CodeSandbox task supervisor
After=runtime-guest-agent.service
[Service]
Type=simple
User=1000
Group=1000
WorkingDirectory=/project/sandbox
ExecStart=/usr/bin/python3 ROOT/service.py ROOT
Restart=on-failure
RestartSec=1
KillMode=control-group
TimeoutStopSec=5
UMask=0077
[Install]
WantedBy=multi-user.target
'''.replace('ROOT',root)
path='/etc/systemd/system/runtime-codesandbox-tasks.service'
if not os.path.exists(path) or open(path).read()!=unit:
 temp=path+'.'+str(os.getpid())+'.tmp'
 with open(temp,'w') as f: f.write(unit)
 os.chmod(temp,0o644)
 os.replace(temp,path)
 subprocess.run(['systemctl','daemon-reload'],check=True)
subprocess.run(['systemctl','enable','--now','runtime-codesandbox-tasks.service'],check=True)
`;
type Run = {
  id: string;
  taskId: string;
  state: "running" | "exited";
  exitCode: number | null;
  command: string;
  startedAt: number;
  error?: string;
};
export class ManagedTasks {
  constructor(private readonly native: Sandbox) {}
  async install(
    tasks: Record<string, { command: string; runAtStart?: boolean }>,
    env: Record<string, string>,
    setup: { steps: { name: string; command: string }[]; source: string },
  ) {
    const revision = crypto.randomUUID();
    const script = `${root}/service-${revision}.py`,
      setupScript = `${root}/setup-${revision}.py`;
    await this.native.files.write(script, taskServiceSource, { mode: 0o600 });
    await this.native.files.write(setupScript, setup.source, { mode: 0o600 });
    const pending = `${root}/config-${revision}.json`;
    await this.native.files.write(
      pending,
      JSON.stringify({
        tasks,
        env,
        cwd: "/project/sandbox",
        setup: { steps: setup.steps, config: JSON.stringify(setup.steps) },
      }),
      { mode: 0o600 },
    );
    await this.native.exec(
      [
        "python3",
        "-c",
        "import os,sys\nfor i in range(1,len(sys.argv),2): os.replace(sys.argv[i],sys.argv[i+1])",
        script,
        `${root}/service.py`,
        setupScript,
        `${root}/setup.py`,
        pending,
        `${root}/config.json`,
      ],
      { check: true },
    );
    await this.native.exec(["sudo", "-n", "python3", "-c", installSource, root], { check: true });
    const until = Date.now() + 5000;
    for (;;) {
      try {
        await this.call({ op: "ping" });
        return;
      } catch (error) {
        if (Date.now() >= until) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  }
  async call<T>(request: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const result = await this.native.exec(["python3", "-c", requestSource, root], {
      check: true,
      signal,
      stdin: JSON.stringify(request),
      onStdout: () => {},
    });
    const reply = JSON.parse(result.stdout) as { ok: boolean; value: T; error?: string };
    if (!reply.ok) throw new Error(reply.error ?? "Task supervisor failed");
    return reply.value;
  }
  async get(taskId: string): Promise<Process | undefined> {
    const run = await this.call<Run | null>({ op: "get", taskId });
    return run ? this.process(run) : undefined;
  }
  async boot(signal?: AbortSignal) {
    if (!(await this.native.files.exists(`${root}/config.json`, { signal }))) return undefined;
    return this.call<{ state: "starting" | "ready" | "failed"; config?: string; error?: string }>(
      { op: "boot" },
      signal,
    );
  }
  async start(taskId: string): Promise<Process> {
    return this.process(await this.call<Run>({ op: "start", taskId }));
  }
  async stop(taskId: string): Promise<Process | undefined> {
    const run = await this.call<Run | null>({ op: "stopTask", taskId });
    return run ? this.process(run) : undefined;
  }
  async list(signal?: AbortSignal) {
    return (await this.call<Run[]>({ op: "list" }, signal)).map((run) => ({
      taskId: run.taskId,
      process: this.process(run),
    }));
  }
  async output(id: string): Promise<string> {
    const chunks: Buffer[] = [];
    let offset = 0,
      until: number | undefined;
    do {
      const result = await this.call<{ data: string; offset: number; size: number }>({
        op: "read",
        id,
        offset,
        until,
      });
      until ??= result.size;
      chunks.push(Buffer.from(result.data, "base64"));
      offset = result.offset;
      if (!result.data) break;
    } while (offset < until);
    return Buffer.concat(chunks).toString("utf8");
  }
  private process(run: Run): Process {
    const call = <T>(request: Record<string, unknown>, signal?: AbortSignal) =>
      this.call<T>(request, signal);
    const handle = {
      id: run.id,
      info: run,
      async *output({ signal }: { signal?: AbortSignal } = {}) {
        let offset = 0;
        const decoder = new TextDecoder();
        for (;;) {
          signal?.throwIfAborted();
          const result = await call<Run & { data: string; offset: number }>(
            { op: "read", id: run.id, offset, waitMs: 2000 },
            signal,
          );
          Object.assign(run, result);
          if (result.data)
            yield {
              type: "stdout",
              data: decoder.decode(Buffer.from(result.data, "base64"), { stream: true }),
              offset,
            };
          offset = result.offset;
          if (result.state !== "running" && !result.data) {
            const tail = decoder.decode();
            if (tail) yield { type: "stdout", data: tail, offset };
            if (result.error) throw new Error(result.error);
            yield { type: "exit", exitCode: result.exitCode, state: "exited", timedOut: false };
            return;
          }
          if (!result.data)
            await new Promise<void>((resolve, reject) => {
              const abort = () => {
                clearTimeout(timer);
                reject(
                  signal?.reason instanceof Error
                    ? signal.reason
                    : new Error("Task subscription cancelled"),
                );
              };
              const timer = setTimeout(() => {
                signal?.removeEventListener("abort", abort);
                resolve();
              }, 100);
              signal?.addEventListener("abort", abort, { once: true });
              if (signal?.aborted) abort();
            });
        }
      },
      async kill() {
        Object.assign(run, await call<Run>({ op: "stop", id: run.id }));
      },
      async resize(cols: number, rows: number) {
        await call({ op: "resize", id: run.id, cols, rows });
      },
      async write(data: string | Uint8Array) {
        await call({ op: "write", id: run.id, data: Buffer.from(data).toString("base64") });
      },
    };
    return handle as unknown as Process;
  }
}
