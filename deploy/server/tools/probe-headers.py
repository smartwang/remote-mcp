# 反代链路诊断探针：把收到的请求头原样回显。
#
# 用来回答一个具体问题：**经过 Cloudflare + WAF 之后，relay 到底看到哪个客户端 IP？**
# 这直接决定限速能不能被绕过 —— 如果那个值请求方自己能伪造，限速就是摆设。
#
# 用法（在服务器上，relay 没跑的时候）：
#   cd /root/remote-mcp-relay
#   cp tools/probe-headers.py /tmp/probe.py && python3 /tmp/probe.py &
#   # 然后从外部访问，看 X-Forwarded-For / CF-Connecting-IP 里各是谁
#   kill %1
#
# 2026-09-18 实测结论（经 CF + SafeLine）：
#   curl -H "X-Forwarded-For: 1.2.3.4" https://mcp.example.com/
#   → 源站收到 X-Forwarded-For: 1.2.3.4,<真实客户端>,<CF回源IP>
#     CF-Connecting-IP: <真实客户端>          ← CF 每次都覆盖，客户端伪造无效
# 也就是 relay 现有的"取 XFF 第一个值"拿到的是**伪造值**。详见 relay/README.md。
from http.server import BaseHTTPRequestHandler, HTTPServer


class H(BaseHTTPRequestHandler):
    def do_GET(self):
        lines = ["PATH=%s" % self.path, "REMOTE=%s" % self.client_address[0]]
        for k, v in self.headers.items():
            lines.append("%s: %s" % (k, v))
        body = ("\n".join(lines) + "\n").encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


HTTPServer(("127.0.0.1", 18086), H).serve_forever()
