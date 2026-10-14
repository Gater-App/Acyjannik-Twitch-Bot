/** Cached reachability check used only when an activity-gated portal tip is due. */
export class CommunityPortalHealth {
  private checkedAt=0;
  private available=false;
  constructor(private readonly url:string,private readonly fetchImpl:typeof fetch=fetch,private readonly ttlMs=60_000){}

  async isAvailable(now=Date.now()):Promise<boolean>{
    if(this.checkedAt>0&&now-this.checkedAt<this.ttlMs)return this.available;
    this.checkedAt=now;
    try{
      const response=await this.fetchImpl(this.url,{headers:{Accept:'text/html'},signal:AbortSignal.timeout(3_000)});
      const html=response.ok&&response.headers.get('content-type')?.includes('text/html')?await response.text():'';
      this.available=response.ok&&html.includes('ACY')&&html.includes('COMMUNITY');
    }catch{this.available=false;}
    return this.available;
  }
}
