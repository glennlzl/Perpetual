"""Fixed requests reviewed by a person. These are not endpoint-prefix or method exemptions."""
import json
import re
from urllib.parse import urlsplit, urlunsplit

JSON_TYPE = re.compile(r'^application/json(?:\s*;\s*charset\s*=\s*"?utf-?8"?)?\s*$', re.I)

def validate_read_requests(value, target):
    if not isinstance(value, list) or len(value) > 10:
        raise ValueError('Add at most 10 read-only POST requests.')
    result = []
    for rule in value:
        if not isinstance(rule, dict) or set(rule) != {'url', 'body'} or not isinstance(rule['url'], str) or not isinstance(rule['body'], str):
            raise ValueError('Provide the URL and exact JSON body of each read-only POST request.')
        address = urlsplit(rule['url'])
        expected = urlsplit(target)
        if len(rule['url']) > 2048 or address.scheme not in {'http', 'https'} or address.username or address.password or '?' in rule['url'] or '#' in rule['url'] or (address.scheme, address.hostname, address.port) != (expected.scheme, expected.hostname, expected.port):
            raise ValueError('Read-only request URLs must be on the application origin, without credentials or queries.')
        if len(rule['body'].encode('utf-8')) > 4096:
            raise ValueError('Use an exact JSON request body of at most 4096 bytes.')
        try:
            body = json.loads(rule['body'])
        except ValueError:
            raise ValueError('The read-only request body must be a JSON object.') from None
        if not isinstance(body, dict):
            raise ValueError('The read-only request body must be a JSON object.')
        normalized = {'url':urlunsplit((address.scheme,address.netloc,address.path or '/', '', '')), 'body':rule['body']}
        if normalized in result:
            raise ValueError('Remove duplicate read-only requests.')
        result.append(normalized)
    return result

def reviewed_read(rules, method, url, body=None, headers=None):
    if method != 'POST' or not isinstance(body, str) or len(body.encode('utf-8')) > 4096:
        return False
    headers = {key.lower():value for key,value in (headers or {}).items()}
    if not JSON_TYPE.fullmatch(headers.get('content-type', '')) or any(key in headers for key in ('x-http-method-override','x-method-override','x-http-method')):
        return False
    address = urlsplit(url)
    if address.username or address.password or '?' in url or '#' in url:
        return False
    candidate = urlunsplit((address.scheme,address.netloc,address.path or '/', '', ''))
    return any(rule['url'] == candidate and rule['body'] == body for rule in rules)
