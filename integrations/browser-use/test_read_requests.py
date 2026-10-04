"""The discovery guard shares the reviewed body modes, without inferring endpoint safety."""
import unittest
from read_requests import validate_read_requests, reviewed_read

class BodylessReads(unittest.TestCase):
    def test_explicit_no_body_and_strict_transport(self):
        url='https://app.example.test/bootstrap'
        rules=validate_read_requests([{'url':url,'body':None}],'https://app.example.test/')
        for body in (None,''):
            self.assertTrue(reviewed_read(rules,'POST',url,body,{}))
        for method,address,body,headers in (
            ('PUT',url,None,{}),('POST',url+'/write',None,{}),('POST',url+'?write=yes',None,{}),
            ('POST',url,'{}',{'content-type':'application/json'}),('POST',url,' ',{}),
            ('POST',url,None,{'content-type':'application/json'}),('POST',url,None,{'X-Method-Override':'DELETE'}),
        ):
            self.assertFalse(reviewed_read(rules,method,address,body,headers))
        for invalid in ('',False,[],{}):
            with self.assertRaises(ValueError):
                validate_read_requests([{'url':url,'body':invalid}],'https://app.example.test/')
