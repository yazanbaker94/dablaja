$ErrorActionPreference = 'Stop'

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$outDir = Join-Path $root 'promo'
$logo = Join-Path $root 'src\popup\wordmark.png'
$outFile = Join-Path $outDir 'dablaja-opener-pro.mp4'
New-Item -ItemType Directory -Path $outDir -Force | Out-Null

$filter = @"
[0:v]drawbox=x=0:y=0:w=iw:h=ih:color=#f7fbfd:t=fill,
drawbox=x='-300+160*t':y=285:w=920:h=3:color=#2ad4c460:t=fill,
drawbox=x='w-620-130*t':y=796:w=720:h=2:color=#16324f20:t=fill,
drawbox=x='650+100*t':y=290:w=6:h=6:color=#2ad4c4b0:t=fill,
drawbox=x='1180-70*t':y=792:w=5:h=5:color=#16324f50:t=fill[bg];
[1:v]format=rgba,scale=w=640:h=-1:eval=init,split=2[glowSrc][logoSrc];
[glowSrc]colorchannelmixer=rr=0.45:gg=1.25:bb=1.25:aa=0.28,gblur=sigma=18,fade=t=in:st=0.35:d=0.75:alpha=1,fade=t=out:st=4.05:d=0.8:alpha=1[glow];
[logoSrc]fade=t=in:st=0.35:d=0.85:alpha=1,fade=t=out:st=4.05:d=0.8:alpha=1[logo];
[bg][glow]overlay=x='(W-w)/2':y='(H-h)/2+5*sin(t*2)':eval=frame:format=auto[tmp];
[tmp][logo]overlay=x='(W-w)/2-360*(1-min(1,max(0,(t-0.62)/0.95)))':y='(H-h)/2+5*sin(t*2)':eval=frame:format=auto,
drawtext=fontfile='C\:/Windows/Fonts/segoeui.ttf':text='LIVE DUBBING FOR EVERY TAB':x=(w-text_w)/2:y=790:fontsize=22:fontcolor=#16324fb0:alpha='if(lt(t,2.0),0,if(lt(t,2.45),(t-2.0)/0.45,if(gt(t,4.0),max(0,1-(t-4.0)/0.75),1)))':enable='gte(t,2.0)'[v]
"@

& ffmpeg -y -f lavfi -i "color=c=#f7fbfd:s=1920x1080:r=30:d=4.9" -loop 1 -i $logo -filter_complex $filter -map "[v]" -t 4.9 -an -c:v libx264 -pix_fmt yuv420p -profile:v high -crf 17 -movflags +faststart $outFile
if ($LASTEXITCODE -ne 0) { throw "ffmpeg failed with exit code $LASTEXITCODE" }
Write-Output $outFile
