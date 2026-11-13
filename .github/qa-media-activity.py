"""Isolated, real-server media activity smoke tests; never uses production data."""
import json, os, pathlib, shutil, subprocess, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright

root = pathlib.Path.cwd()
out = root / 'qa-evidence'
out.mkdir(exist_ok=True)
data = pathlib.Path(tempfile.mkdtemp(prefix='frame-activity-qa-'))
photos = data / 'photos'
photos.mkdir()
config = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', "import {defaultConfig} from './shared/dist/index.js'; console.log(JSON.stringify(defaultConfig()))"], text=True))
config.update(photoPeriod=3600, showQr=False, transitionPeriod=0.1, interactiveTransitionPeriod=0.1, motion='none', videoAudioMode='muted')
items = []
for index, (ident, name, views, selections, color) in enumerate([
    ('unseen','Unseen landscape',0,0,'#546b78'), ('few','City afternoon',3,1,'#8b6e63'),
    ('popular','Evening mountains',25,12,'#556e54'), ('legacy','Legacy photograph',0,0,'#675d82')]):
    filename = ident + '.svg'
    (photos / filename).write_text(f'<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="{color}"/><circle cx="470" cy="95" r="45" fill="#e7cda7"/><path d="M0 360L180 100 350 360M220 360L420 145 640 360" fill="#25343c"/><text x="28" y="325" fill="white" font-family="sans-serif" font-size="23">{name}</text></svg>')
    item = dict(id=ident, kind='photo', file=filename, thumb=filename, preview=filename, originalFilename=name+'.jpg', width=640, height=360, createdAt=1000+index, source='upload')
    if ident != 'legacy': item['usage'] = dict(viewCount=views, playCount=0, clickCount=views, selectedCount=selections)
    items.append(item)
subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=640x360:rate=24','-t','12','-c:v','libx264','-profile:v','baseline','-pix_fmt','yuv420p','-movflags','+faststart',str(photos/'video.mp4')], check=True)
items.append(dict(id='video',kind='video',file='video.mp4',thumb='few.svg',preview='few.svg',poster='few.svg',originalFilename='Coastal motion.mp4',width=640,height=360,durationSec=12,createdAt=1010,source='upload',usage=dict(viewCount=0,playCount=7,clickCount=10,selectedCount=4)))
items.append(dict(id='broken',kind='video',file='missing.mp4',thumb='legacy.svg',preview='legacy.svg',poster='legacy.svg',originalFilename='Unavailable test video.mp4',width=640,height=360,createdAt=1011,source='upload',enabled=False))
(data/'frame.json').write_text(json.dumps(dict(config=config,items=items,trash=[],order=[i['id'] for i in items])))
env = {**os.environ,'FRAME_DATA_DIR':str(data),'FRAME_DISABLE_HTTPS':'1','FRAME_HTTP_PORT':'9095','FRAME_ADMIN_PASSWORD':'qa-local-only'}
log = (out/'server.log').open('w')
server = subprocess.Popen(['node','server/dist/index.js'],env=env,stdout=log,stderr=log)
checks = []
errors = []
def check(value, message):
    assert value, message
    checks.append(message)
try:
    for _ in range(100):
        try:
            urllib.request.urlopen('http://127.0.0.1:9095/api/health',timeout=1)
            break
        except Exception: time.sleep(.1)
    with sync_playwright() as p:
        executable = next((shutil.which(name) for name in ['google-chrome','chromium','google-chrome-stable'] if shutil.which(name)),None)
        assert executable, 'Chrome is required for browser QA'
        browser = p.chromium.launch(executable_path=executable,headless=True,args=['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader','--autoplay-policy=no-user-gesture-required'])
        ctx = browser.new_context(viewport=dict(width=1365,height=900))
        page = ctx.new_page()
        page.on('pageerror',lambda e: errors.append(str(e)))
        base = 'http://127.0.0.1:9095'
        def api(path):
            response = ctx.request.get(base+path)
            assert response.ok, (path,response.status,response.text())
            return response.json()
        def usage(ident, key):
            rows = api('/api/media/activity?limit=500')['items']
            return next(i for i in rows if i['id']==ident).get('usage',{}).get(key,0)
        def wait_usage(ident,key,value):
            for _ in range(60):
                if usage(ident,key)==value: return
                page.wait_for_timeout(100)
            raise AssertionError((ident,key,value,usage(ident,key)))
        def ids(): return page.locator('#grid .tile').evaluate_all('(els)=>els.map(e=>e.dataset.mediaId)')
        def reset(): page.locator('#media-filter-reset').click(); page.wait_for_timeout(100)
        try:
            check(ctx.request.get(base+'/api/media/activity').status==401,'Usage API requires authentication')
            page.goto(base+'/admin/')
            page.locator('#login-pw').fill('qa-local-only'); page.locator('#login-submit').click()
            page.wait_for_selector('#grid .tile'); page.wait_for_timeout(400)
            check(len(ids())==6,'All media load after login')
            check(usage('unseen','viewCount')==0,'Thumbnail browsing does not count a view')
            page.screenshot(path=str(out/'desktop-library.png'),full_page=True)
            page.locator('[data-activity-preset="never"]').click()
            check(set(ids())=={'unseen','legacy','broken'},'Never viewed/played includes legacy zero values')
            page.locator('[data-activity-preset="popular"]').click()
            check(ids()[0]=='popular','Most viewed/played sorting is correct')
            page.locator('[data-activity-preset="selected"]').click()
            check(ids()[0]=='popular','Most selected sorting is correct')
            reset(); page.locator('.activity-ranges > summary').click()
            page.locator('[data-count-bound="activityMin"]').fill('3');page.locator('[data-count-bound="activityMin"]').dispatch_event('change')
            page.locator('[data-count-bound="activityMax"]').fill('7');page.locator('[data-count-bound="activityMax"]').dispatch_event('change')
            check(set(ids())=={'few','video'},'Inclusive count range filters correctly')
            page.locator('[data-count-bound="activityMin"]').fill('8');page.locator('[data-count-bound="activityMin"]').dispatch_event('change')
            check(bool(page.locator('#activity-error').inner_text()),'Invalid range has an accessible error')
            reset(); page.locator('#media-search').fill('City');page.wait_for_timeout(300)
            check(ids()==['few'],'Filename search narrows the library')
            page.locator('#select-visible').click();wait_usage('few','selectedCount',2)
            check(page.locator('#selection-count').inner_text().startswith('1 '),'Select all uses the filtered result set')
            page.locator('#select-visible').click();page.wait_for_timeout(200)
            check(usage('few','selectedCount')==2,'Selecting already-selected items does not inflate history')
            page.locator('#clear-selection').click();check(usage('few','selectedCount')==2,'Clearing selection preserves history')
            reset(); page.locator('[data-mode="view"]').click()
            page.locator('[data-media-id="unseen"]').click();page.wait_for_selector('dialog[open] img');wait_usage('unseen','viewCount',1)
            check(usage('unseen','clickCount')==1,'Opening a photo records one click and one successful view')
            page.locator('dialog button').click()
            page.locator('[data-media-id="video"]').click();page.wait_for_selector('dialog[open] video')
            page.locator('dialog video').evaluate('(v)=>v.play()');wait_usage('video','playCount',8)
            page.locator('dialog video').evaluate('(v)=>{v.pause();return v.play()}');page.wait_for_timeout(300)
            check(usage('video','playCount')==8,'Preview pause/resume does not add a play')
            page.locator('dialog button').click()
            page.locator('[data-media-id="broken"]').click();page.wait_for_function("document.querySelector('dialog p')?.textContent.includes('could not be loaded')")
            check(usage('broken','playCount')==0,'Failed media does not count as played')
            page.locator('dialog button').click()
            page.locator('[data-mode="cast"]').click();page.locator('[data-media-id="popular"]').click()
            page.wait_for_function("document.querySelector('#quick-title')?.textContent.includes('Evening')")
            check(usage('popular','viewCount')==25,'A cast command without a display does not create a view')
            page.locator('#media-search').fill('City');page.wait_for_timeout(300);page.locator('#quick-find').click()
            check(len(ids())==6,'Find current media clears filters')
            page.locator('#library-layout').click();check('list-layout' in page.locator('#grid').get_attribute('class'),'List layout is available')
            page.screenshot(path=str(out/'desktop-list.png'),full_page=True)
            page.locator('#library-layout').click()
            for width in [390,320]:
                page.set_viewport_size(dict(width=width,height=844));page.wait_for_timeout(100)
                check(page.evaluate('document.documentElement.scrollWidth <= innerWidth'),'No horizontal overflow at '+str(width)+'px')
                page.screenshot(path=str(out/('mobile-'+str(width)+'.png')),full_page=True)
                page.locator('#quick-controls').click();page.wait_for_selector('#control-sheet.open')
                check(page.locator('#control-sheet').evaluate('(e)=>e.scrollHeight>=e.clientHeight'),'Controls sheet scrolls at '+str(width)+'px')
                page.screenshot(path=str(out/('controls-'+str(width)+'.png')))
                page.locator('#controls-close').click()
            page.set_viewport_size(dict(width=1365,height=900))
            api('/api/pause');api('/api/cast/unseen')
            display = ctx.new_page();display.on('pageerror',lambda e:errors.append(str(e)))
            display.goto(base+'/');display.bring_to_front();wait_usage('unseen','viewCount',2)
            display.screenshot(path=str(out/'display-photo.png'))
            api('/api/cast/video');display.wait_for_timeout(500)
            check(usage('video','playCount')==8,'Paused display does not count an unstarted video')
            api('/api/resume');wait_usage('video','playCount',9)
            api('/api/pause');api('/api/resume');display.wait_for_timeout(500)
            check(usage('video','playCount')==9,'Display pause/resume does not duplicate plays')
            display.screenshot(path=str(out/'display-video.png'))
            api('/api/cast/video');wait_usage('video','playCount',10)
            check(usage('video','playCount')==10,'A new confirmed presentation creates a new play')
            check(not errors,'No uncaught browser errors')
        except Exception:
            page.screenshot(path=str(out/'failure.png'),full_page=True)
            (out/'failure.html').write_text(page.content())
            raise
        finally:
            (out/'browser-results.json').write_text(json.dumps(dict(checks=checks,errors=errors),indent=2))
            browser.close()
finally:
    server.terminate();server.wait(timeout=10);log.close()
print(json.dumps(dict(passed=len(checks),checks=checks,errors=errors),indent=2))
