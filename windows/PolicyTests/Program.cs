using System.Text.Json;
using CodexCo2;

void Check(bool value) { if (!value) throw new Exception("Synthetic Windows policy test failed"); }
var token = new string('A', 43);
var fragment = "#room=synthetic-room&invite=" + token;
foreach (var host in new[] { "https://synthetic.example/", "http://10.1.2.3:8080/", "http://172.16.2.3:8080/", "http://192.168.1.2:8090/" })
    Check(Policy.Invitation(host + fragment));
foreach (var raw in new[] {
    "http://127.0.0.1:8080/", "http://203.0.113.1:8080/", "http://100.64.0.1:8080/", "http://172.32.1.2:8080/",
    "http://192.168.001.2:8080/", "http://%31%30.1.2.3:8080/", "http://10.1.2.3/", "http://internal.example:8080/",
    "https://synthetic.example/path/", "https://synthetic.example/?unexpected=1", "file:///tmp/" }) Check(!Policy.Invitation(raw + fragment));
Check(!Policy.Invitation("https://synthetic.example/" + fragment + "&invite=" + token));
Check(!Policy.Invitation("https://synthetic.example/" + fragment + "&scope="));
Check(!Policy.Invitation("https://synthetic.example/" + fragment + "\n"));
Check(!Policy.Invitation("https://synthetic.example/#room=synthetic-room&invite=" + new string('B', 43)));
Check(Policy.ManagerUrl("http://127.0.0.1:31001/owner#synthetic", out var origin));
Check(Policy.SameOrigin(origin, "http://127.0.0.1:31001/owner.js"));
foreach (var raw in new[] { "https://127.0.0.1:31001/", "http://localhost:31001/", "http://127.0.0.1:31002/", "http://user@127.0.0.1:31001/", "file:///tmp/" })
    Check(!Policy.SameOrigin(origin, raw));
foreach (var raw in new[] { "http://127.0.0.1/", "http://localhost:31001/", "https://127.0.0.1:31001/", "http://user@127.0.0.1:31001/" })
    Check(!Policy.ManagerUrl(raw, out _));
var valid = JsonSerializer.SerializeToElement(new { requestId = "copy-1", url = "https://synthetic.example/" + fragment });
Check(Policy.CopyRequest(valid, out var id, out _) && id == "copy-1");
Check(!Policy.CopyRequest(JsonSerializer.SerializeToElement(new { requestId = "copy-1", url = "https://synthetic.example/" + fragment, extra = true }), out _, out _));
Console.WriteLine("Windows native policy synthetic tests passed");
