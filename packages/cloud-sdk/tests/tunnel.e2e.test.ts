/* The tunnel's end-to-end tests (tests/tunnel.test.ts, those skipped unless
   endToEnd): a real ssh client and sshd over the tunnel, the editor's login
   through the ssh entry it installs, ssh through the CLI as ProxyCommand, and
   the Python SDK's forward_port. Each starts processes of other languages,
   about 1.3 s together, so they run on main's check (tests/fixtures/
   end-to-end.ts). */
import "./tunnel.test";
