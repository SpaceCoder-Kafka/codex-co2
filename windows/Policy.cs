using System.Text.Json;
using System.Text.RegularExpressions;

namespace CodexCo2;

// Keep the native capability boundary independent of WebView/clipboard APIs so
// it can also be executed with synthetic inputs on non-Windows build hosts.
internal static class Policy
{
    public const string Repository = "https://github.com/SpaceCoder-Kafka/codex-co2";
    public static bool ManagerUrl(string? raw, out Uri? value)
    {
        value = null;
        if (raw is null || raw.Length > 4096 || !Uri.TryCreate(raw, UriKind.Absolute, out var url)
            || url.Scheme != "http" || url.Host != "127.0.0.1" || url.Port < 1 || url.IsDefaultPort
            || url.UserInfo.Length != 0 || raw.Any(char.IsControl)) return false;
        value = url; return true;
    }
    public static bool SameOrigin(Uri? origin, string? candidate) => origin is not null
        && Uri.TryCreate(candidate, UriKind.Absolute, out var url)
        && url.Scheme == origin.Scheme && url.Host == origin.Host && url.Port == origin.Port
        && url.UserInfo.Length == 0;
    public static bool PrivateIPv4(string host)
    {
        var parts = host.Split('.');
        if (parts.Length != 4) return false;
        var octets = new int[4];
        for (var i = 0; i < 4; i++)
            if (!int.TryParse(parts[i], out octets[i]) || octets[i] < 0 || octets[i] > 255
                || octets[i].ToString() != parts[i]) return false;
        return octets[0] == 10 || (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31)
            || (octets[0] == 192 && octets[1] == 168);
    }
    public static bool Invitation(string raw)
    {
        if (raw.Length >= 4096 || raw.Any(c => char.IsControl(c) || char.IsWhiteSpace(c))
            || !Uri.TryCreate(raw, UriKind.Absolute, out var url) || url.UserInfo.Length != 0
            || url.Query.Length != 0 || url.AbsolutePath != "/" || url.Port is < 1 or > 65535) return false;
        // Compare the raw authority as well: System.Uri normalizes octal-like
        // IPv4 forms and percent escapes, which must not authorize LAN links.
        var authority = raw.Split(new[] { "://" }, StringSplitOptions.None).ElementAtOrDefault(1)?.Split('/')[0].Split('#')[0];
        if (url.Scheme == "http")
        {
            if (!PrivateIPv4(url.Host) || authority != url.Host + ":" + url.Port) return false;
        }
        else if (url.Scheme != "https") return false;
        var fields = new Dictionary<string, string>();
        foreach (var field in url.Fragment.TrimStart('#').Split('&'))
        {
            var pair = field.Split('=', 2);
            if (pair.Length != 2 || pair[0] is not ("room" or "invite" or "scope")
                || !fields.TryAdd(pair[0], pair[1])) return false;
        }
        if (!fields.TryGetValue("room", out var room) || !Regex.IsMatch(room, "^[A-Za-z0-9_-]{8,128}$")
            || !fields.TryGetValue("invite", out var token) || !Regex.IsMatch(token, "^[A-Za-z0-9_-]{43}$")) return false;
        try
        {
            var bytes = Convert.FromBase64String(token.Replace('-', '+').Replace('_', '/') + "=");
            if (bytes.Length != 32 || Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_') != token) return false;
        }
        catch { return false; }
        return !fields.TryGetValue("scope", out var scope) || Regex.IsMatch(scope, "^[A-Za-z0-9_-]{1,128}$");
    }
    public static bool CopyRequest(JsonElement value, out string id, out string url)
    {
        id = ""; url = "";
        if (value.ValueKind != JsonValueKind.Object || value.EnumerateObject().Count() != 2
            || !value.TryGetProperty("requestId", out var request) || request.ValueKind != JsonValueKind.String
            || !value.TryGetProperty("url", out var link) || link.ValueKind != JsonValueKind.String) return false;
        id = request.GetString() ?? ""; url = link.GetString() ?? "";
        return id.Length <= 64 && Regex.IsMatch(id, "^copy-[1-9][0-9]*$") && Invitation(url);
    }
}
