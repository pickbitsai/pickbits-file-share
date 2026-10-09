// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits File Share.
import { createApi } from './api.mjs';
import { createAwsAdapters } from './aws-adapters.mjs';
const api=createApi({adapters:createAwsAdapters()});
export async function handler(event){
  const headers=new Headers(event.headers||{});if(event.cookies)headers.set('cookie',event.cookies.join('; '));
  const body=event.body?Buffer.from(event.body,event.isBase64Encoded?'base64':'utf8'):undefined;
  const request=new Request(`${process.env.APP_ORIGIN}${event.rawPath}${event.rawQueryString?'?'+event.rawQueryString:''}`,{method:event.requestContext.http.method,headers,body});
  const response=await api(request);const outHeaders=Object.fromEntries(response.headers);delete outHeaders['set-cookie'];
  return {statusCode:response.status,headers:outHeaders,cookies:response.headers.getSetCookie(),body:await response.text()};
}
