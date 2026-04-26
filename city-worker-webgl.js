(function (global) {
    "use strict";
  
    var VS_MAIN = `#version 300 es
      in vec2 a_pos; in vec4 a_col; out vec4 v_col; uniform vec2 u_res;
      void main(){ vec2 ndc=(a_pos/u_res)*2.0-1.0; gl_Position=vec4(ndc.x,-ndc.y,0.0,1.0); v_col=a_col; }`;
    var FS_MAIN = `#version 300 es
      precision mediump float; in vec4 v_col; out vec4 fragColor;
      void main(){ fragColor=v_col; }`;
  
    var VS_POINT = `#version 300 es
      in vec2 a_pos; in float a_size; in vec4 a_col; out vec4 v_col;
      uniform vec2 u_res; uniform float u_dpr;
      void main(){ vec2 ndc=(a_pos/u_res)*2.0-1.0; gl_Position=vec4(ndc.x,-ndc.y,0.0,1.0); gl_PointSize=a_size*u_dpr; v_col=a_col; }`;
    var FS_POINT = `#version 300 es
      precision mediump float; in vec4 v_col; out vec4 fragColor;
      void main(){ vec2 pc=gl_PointCoord*2.0-1.0; float d=dot(pc,pc);
        if(d>1.0)discard; float edge=1.0-smoothstep(0.15,1.0,d); fragColor=vec4(v_col.rgb,v_col.a*edge); }`;
  
    var VS_SCREEN = `#version 300 es
      in vec2 a_pos; out vec2 v_uv;
      void main(){ gl_Position=vec4(a_pos,0.0,1.0); v_uv=a_pos*0.5+0.5; }`;
    var FS_TEX = `#version 300 es
      precision mediump float; in vec2 v_uv; out vec4 fragColor; uniform sampler2D u_tex;
      void main(){ fragColor=texture(u_tex,v_uv); }`;
    var FS_BLUR = `#version 300 es
      precision mediump float; in vec2 v_uv; out vec4 fragColor; uniform sampler2D u_tex; uniform vec2 u_dir;
      void main(){ vec4 s=vec4(0.0);
        s+=texture(u_tex,v_uv-4.0*u_dir)*0.0162; s+=texture(u_tex,v_uv-3.0*u_dir)*0.0540;
        s+=texture(u_tex,v_uv-2.0*u_dir)*0.1218; s+=texture(u_tex,v_uv-1.0*u_dir)*0.1962;
        s+=texture(u_tex,v_uv)*0.2236;
        s+=texture(u_tex,v_uv+1.0*u_dir)*0.1962; s+=texture(u_tex,v_uv+2.0*u_dir)*0.1218;
        s+=texture(u_tex,v_uv+3.0*u_dir)*0.0540; s+=texture(u_tex,v_uv+4.0*u_dir)*0.0162;
        fragColor=s; }`;
  
    function compileShader(gl,type,src){var s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);
      if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))console.error("Shader:",gl.getShaderInfoLog(s));return s;}
    function makeProgram(gl,vs,fs){var p=gl.createProgram();gl.attachShader(p,compileShader(gl,gl.VERTEX_SHADER,vs));
      gl.attachShader(p,compileShader(gl,gl.FRAGMENT_SHADER,fs));gl.linkProgram(p);
      if(!gl.getProgramParameter(p,gl.LINK_STATUS))console.error("Link:",gl.getProgramInfoLog(p));return p;}
    function makeFBO(gl,w,h){var tex=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,tex);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,w,h,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      var fb=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,tex,0);
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);return{fb:fb,tex:tex,w:w,h:h};}
    function resizeFBO(gl,fbo,w,h){fbo.w=w;fbo.h=h;gl.bindTexture(gl.TEXTURE_2D,fbo.tex);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,w,h,0,gl.RGBA,gl.UNSIGNED_BYTE,null);}
    function createFallbackCanvas(w,h){if(typeof OffscreenCanvas!=="undefined")return new OffscreenCanvas(w,h);
      if(typeof document!=="undefined")return document.createElement("canvas");return null;}
  
    function createCityRuntime(options){
      options=options||{};var canvas=options.canvas;
      var gl=canvas.getContext("webgl2",{alpha:true,antialias:false,premultipliedAlpha:false,preserveDrawingBuffer:false});
      if(!gl){console.error("WebGL2 not available");return null;}
      var gridCanvas=createFallbackCanvas(1,1);var gridCtx=gridCanvas?gridCanvas.getContext("2d",{alpha:true}):null;
      var overlayCanvas=options.overlayCanvas||createFallbackCanvas(1,1);
      var particleCtx=overlayCanvas?overlayCanvas.getContext("2d",{alpha:true}):null;
      var dpr=Math.min(options.dpr||1,2),reducedMotion=!!options.reducedMotion,targetFPS=60,lastFrameTime=0;
      var raf=typeof global.requestAnimationFrame==="function"?global.requestAnimationFrame.bind(global):function(cb){return global.setTimeout(function(){cb(performance.now());},1000/60);};
      var caf=typeof global.cancelAnimationFrame==="function"?global.cancelAnimationFrame.bind(global):global.clearTimeout.bind(global);
  
      var progMain=makeProgram(gl,VS_MAIN,FS_MAIN),progPoint=makeProgram(gl,VS_POINT,FS_POINT);
      var progTex=makeProgram(gl,VS_SCREEN,FS_TEX),progBlur=makeProgram(gl,VS_SCREEN,FS_BLUR);
      var mainAP=gl.getAttribLocation(progMain,"a_pos"),mainAC=gl.getAttribLocation(progMain,"a_col"),mainUR=gl.getUniformLocation(progMain,"u_res");
      var ptAP=gl.getAttribLocation(progPoint,"a_pos"),ptAS=gl.getAttribLocation(progPoint,"a_size"),ptAC=gl.getAttribLocation(progPoint,"a_col");
      var ptUR=gl.getUniformLocation(progPoint,"u_res"),ptUD=gl.getUniformLocation(progPoint,"u_dpr");
      var texAP=gl.getAttribLocation(progTex,"a_pos"),texUT=gl.getUniformLocation(progTex,"u_tex");
      var blurAP=gl.getAttribLocation(progBlur,"a_pos"),blurUT=gl.getUniformLocation(progBlur,"u_tex"),blurUD=gl.getUniformLocation(progBlur,"u_dir");
  
      var MAX_V=420000,S6=6,sceneBuf=new Float32Array(MAX_V*S6),sceneN=0;
      var glowBuf=new Float32Array(80000*S6),glowN=0;
      var screenBlendBuf=new Float32Array(20000*S6),screenBlendN=0;
      var vbo=gl.createBuffer(),glowVbo=gl.createBuffer(),screenVbo=gl.createBuffer();
  
      var MAX_PT=80000,S7=7,pointBuf=new Float32Array(MAX_PT*S7),pointN=0;
      var glowPtBuf=new Float32Array(8000*S7),glowPtN=0;
      var ptVbo=gl.createBuffer(),glowPtVbo=gl.createBuffer();
  
      var quadBuf=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,quadBuf);
      gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);
  
      function mkTriVAO(buf){var v=gl.createVertexArray();gl.bindVertexArray(v);gl.bindBuffer(gl.ARRAY_BUFFER,buf);
        gl.enableVertexAttribArray(mainAP);gl.vertexAttribPointer(mainAP,2,gl.FLOAT,false,S6*4,0);
        gl.enableVertexAttribArray(mainAC);gl.vertexAttribPointer(mainAC,4,gl.FLOAT,false,S6*4,8);
        gl.bindVertexArray(null);return v;}
      var vaoMain=mkTriVAO(vbo),vaoGlow=mkTriVAO(glowVbo),vaoScreen=mkTriVAO(screenVbo);
  
      function mkPtVAO(buf){var v=gl.createVertexArray();gl.bindVertexArray(v);gl.bindBuffer(gl.ARRAY_BUFFER,buf);
        gl.enableVertexAttribArray(ptAP);gl.vertexAttribPointer(ptAP,2,gl.FLOAT,false,S7*4,0);
        gl.enableVertexAttribArray(ptAS);gl.vertexAttribPointer(ptAS,1,gl.FLOAT,false,S7*4,8);
        gl.enableVertexAttribArray(ptAC);gl.vertexAttribPointer(ptAC,4,gl.FLOAT,false,S7*4,12);
        gl.bindVertexArray(null);return v;}
      var vaoPt=mkPtVAO(ptVbo),vaoGlowPt=mkPtVAO(glowPtVbo);
  
      var gridTex=gl.createTexture(),particleTex=gl.createTexture();
      function initTex(t){gl.bindTexture(gl.TEXTURE_2D,t);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);}
      initTex(gridTex);initTex(particleTex);
      var glowFBO=makeFBO(gl,1,1),blurFBO=makeFBO(gl,1,1),bloomW=1,bloomH=1;
  
      var PITCH=0.46,FOCAL=720,CAM_HEIGHT=520,DOLLY_SPEED=66,CAM_X_DRIFT=0,NEAR_PLANE=40,FAR_PLANE=4000;
      var ST_PITCH=300,ST_GAP=52,ST_SETBACK=14,BLK_INNER=ST_PITCH-ST_GAP;
      var ARC_NEAR_MAX=320,ARC_FAR_MAX=820,TARGET_ARCS=6,TARGET_HOT=12;
      var GRID_HALF_W=2600,GRID_EXTENT=6800;
      var W=0,H=0,HORIZON_Y=0,cameraX=0,cameraZ=0,lastTime=performance.now(),smoothDelta=1/60;
      var buildings=[],arcs=[],particles=[],running=true,frameId=null,frameCount=0;
      var gridCacheDirty=true,gridMajorPath=null,gridMinorPath=null;
      var windowDensityScale=2,renderCap=Infinity,qualityLevel=0,qualityRestoreStarted=0;
      var fpsSamples=new Float32Array(60),fpsSampleIndex=0,fpsSampleCount=0,fpsAverage=60;
      var drawList=[],sourceList=[],targetList=[];
      var _p0={x:0,y:0,depth:0,visible:false},_p1={x:0,y:0,depth:0,visible:false};
      var _p2={x:0,y:0,depth:0,visible:false},_p3={x:0,y:0,depth:0,visible:false};
      var _ads={x:0,y:0,depth:0,visible:false},_adp={x:0,y:0,z:0};
      var sinP=Math.sin(PITCH),cosP=Math.cos(PITCH);
      function rand(a,b){return a+Math.random()*(b-a);}function randInt(a,b){return Math.floor(rand(a,b+1));}
      function hash01(n){return Math.abs(Math.sin(n)*43758.5453123)%1;}
      function clamp(v,lo,hi){return Math.max(lo,Math.min(hi,v));}
      function depthSortDesc(a,b){return b.depth-a.depth;}
      function fogBlend(b255,f255,mix){return(b255+(f255-b255)*mix)/255;}
      function fogForBuilding(b){if(b.fogFrame>=0&&frameCount%2!==0)return b.fog;b.fog=clamp((b.z-cameraZ-1500)/3900,0,1);b.fogFrame=frameCount;return b.fog;}
      function distanceFade(b){var d=b.z-cameraZ;return clamp((d-40)/120,0,1)*clamp(1-(d-3600)/900,0,1)*clamp(1-(Math.abs(b.x-cameraX)-1800)/500,0,1);}
      function visualHot(b){if(!b.hot)return false;var d=b.z-cameraZ;if(d<80||d>1600)return false;
        if(!projectInto(b.x,b.h,b.z,_p0))return false;return(Math.max(b.w,b.d)*FOCAL)/Math.max(_p0.depth,1)<=W*0.28;}
  
      function projectInto(wx,wy,wz,out){var dx=wx-cameraX,dy=wy-CAM_HEIGHT,dz=wz-cameraZ;
        var ry=dy*cosP+dz*sinP,rz=-dy*sinP+dz*cosP;if(rz<NEAR_PLANE+5){out.visible=false;return false;}
        out.x=W/2+(dx*FOCAL)/rz;out.y=HORIZON_Y-(ry*FOCAL)/rz+Math.tan(PITCH)*FOCAL;out.depth=rz;out.visible=true;return true;}
      function cameraDepth(wx,wy,wz){return-(wy-CAM_HEIGHT)*sinP+(wz-cameraZ)*cosP;}
      function buildingDrawDepth(b){return cameraDepth(b.x,0,b.z-b.d*.5);}
      function buildingInView(b){if(!projectInto(b.x,b.h*0.5,b.z,b.cullProj))return false;
        if(b.cullProj.depth<NEAR_PLANE||b.cullProj.depth>FAR_PLANE)return false;
        var r=(b.radius*FOCAL)/Math.max(b.cullProj.depth,1);
        return b.cullProj.x>=-r&&b.cullProj.x<=W+r&&b.cullProj.y>=-r&&b.cullProj.y<=H+r;}
      function projectBuilding(b){var d=b.z-cameraZ;if(d>500&&b.projFrame>=0&&frameCount%2!==0)return true;
        var c=b.corners;for(var i=0;i<8;i++){var j=i*3;if(!projectInto(c[j],c[j+1],c[j+2],b.screen[i]))return false;}
        b.projFrame=frameCount;return true;}
      function faceVisible(nx,ny,nz,cx,cy,cz){return nx*(cameraX-cx)+ny*(CAM_HEIGHT-cy)+nz*(cameraZ-cz)>0;}
      function arcPointInto(arc,t,out){var o=1-t;out.x=o*o*arc.ax+2*o*t*arc.mx+t*t*arc.bx;
        out.y=o*o*arc.ay+2*o*t*arc.my+t*t*arc.by;out.z=o*o*arc.az+2*o*t*arc.mz+t*t*arc.bz;}
  
      function pickType(rd){var r=Math.random();if(rd<360&&r<0.46)return"tower";
        if(rd<360){if(r<0.92)return"midrise";if(r<0.98)return"lowcomm";return"irregular";}
        if(rd<720){if(r<0.22)return"tower";if(r<0.88)return"midrise";if(r<0.97)return"lowcomm";return"irregular";}
        if(r<0.08)return"tower";if(r<0.78)return"midrise";if(r<0.94)return"lowcomm";return"irregular";}
      function dimsForType(t){switch(t){case"tower":return{w:rand(48,78),d:rand(48,78),h:rand(220,380)};
        case"midrise":return{w:rand(62,108),d:rand(62,108),h:rand(120,220)};
        case"lowcomm":return{w:rand(85,145),d:rand(70,125),h:rand(55,90)};
        case"irregular":return{w:rand(82,150),d:rand(95,170),h:rand(45,80)};
        default:return{w:rand(80,130),d:rand(80,130),h:rand(30,60)};}}
      function makeRoofBoxes(w,d,h){var n=h>80?randInt(3,5):h>48?randInt(2,4):randInt(1,3);var b=[];
        for(var i=0;i<n;i++)b.push({rx:rand(-w*.32,w*.32),rz:rand(-d*.32,d*.32),
          rw:rand(7,Math.min(24,w*.26)),rd:rand(7,Math.min(24,d*.26)),rh:rand(4,13),
          screen:[{x:0,y:0,depth:0,visible:false},{x:0,y:0,depth:0,visible:false},{x:0,y:0,depth:0,visible:false},{x:0,y:0,depth:0,visible:false},
            {x:0,y:0,depth:0,visible:false},{x:0,y:0,depth:0,visible:false},{x:0,y:0,depth:0,visible:false},{x:0,y:0,depth:0,visible:false}]});return b;}
      function buildWindowCache(wu,hu,salt){var w=[];if(hu<=40)return w;
        var cols=Math.max(2,Math.floor(wu/12)),rows=Math.max(3,Math.floor(hu/8));
        for(var r=1;r<rows;r++){var v=r/rows;for(var c=1;c<cols;c++){var rn=hash01(salt+r*37.17+c*91.31);
          if(rn<0.3)continue;w.push({u:c/cols,v:v,bright:rn>0.95});}}return w;}
      function setBuildingGeometry(b){var hw=b.w/2,hd=b.d/2,x0=b.x-hw,x1=b.x+hw,z0=b.z-hd,z1=b.z+hd;
        if(!b.corners)b.corners=new Float32Array(24);
        b.corners.set([x0,0,z0,x1,0,z0,x1,0,z1,x0,0,z1,x0,b.h,z0,x1,b.h,z0,x1,b.h,z1,x0,b.h,z1]);
        if(!b.screen){b.screen=[];for(var i=0;i<8;i++)b.screen.push({x:0,y:0,depth:0,visible:false});}
        if(!b.cullProj)b.cullProj={x:0,y:0,depth:0,visible:false};
        if(!b.miscProj)b.miscProj={x:0,y:0,depth:0,visible:false};
        b.radius=Math.sqrt(b.w*b.w+b.h*b.h+b.d*b.d)/2;var t=b.seedTone||0;
        b.baseFrontR=13+t;b.baseFrontG=17+t;b.baseFrontB=24+Math.round(t*1.4);
        b.baseSideR=10+t;b.baseSideG=14+t;b.baseSideB=20+t;
        b.baseTopR=19+t;b.baseTopG=26+t;b.baseTopB=38+t;
        b.roofFrontR=22+t;b.roofFrontG=30+t;b.roofFrontB=42+t;
        b.roofLeftR=18+t;b.roofLeftG=24+t;b.roofLeftB=34+t;
        b.roofRightR=16+t;b.roofRightG=22+t;b.roofRightB=32+t;
        b.roofTopR=30+t;b.roofTopG=40+t;b.roofTopB=56+t;
        b.frontWindows=buildWindowCache(b.w,b.h,b.x*0.13+b.z*0.07);
        b.sideWindows=buildWindowCache(b.d,b.h,b.x*0.19+b.z*0.11+19);
        b.projFrame=-1;b.fogFrame=-1;}
      function createBuilding(d){setBuildingGeometry(d);return d;}
      function footprintsOverlap(a,b,p){return Math.abs(a.x-b.x)<(a.w+b.w)/2+p&&Math.abs(a.z-b.z)<(a.d+b.d)/2+p;}
      function placementIsClear(c,pl,pad,ig){for(var i=0;i<pl.length;i++){if(pl[i]===ig)continue;if(footprintsOverlap(c,pl[i],pad))return false;}return true;}
      function makeBuildingInCell(xi,zi){var cc={x:0,z:cameraZ+2200};var bx=xi*ST_PITCH,bz=zi*ST_PITCH+BLK_INNER/2;
        var dx=bx-cc.x,dz=bz-cc.z,rd=Math.sqrt(dx*dx+dz*dz);var tp=pickType(rd),dm=dimsForType(tp);
        var hw=dm.w/2,hd=dm.d/2;var xMin=bx-BLK_INNER/2+ST_SETBACK,xMax=bx+BLK_INNER/2-ST_SETBACK;
        var zMin=zi*ST_PITCH+ST_GAP/2+ST_SETBACK,zMax=(zi+1)*ST_PITCH-ST_GAP/2-ST_SETBACK;
        var xlo=xMin+hw,xhi=xMax-hw,zlo=zMin+hd,zhi=zMax-hd;if(xlo>xhi||zlo>zhi)return null;
        return createBuilding({x:rand(xlo,xhi)+rand(-5,5),z:rand(zlo,zhi)+rand(-5,5),w:dm.w,d:dm.d,h:dm.h,type:tp,
          hot:false,hotPhase:rand(0,Math.PI*2),hotEndsAt:0,infectedAt:0,nextArcAt:0,flickerStart:0,
          seedTone:Math.floor(rand(0,8)),floorH:rand(9,14),roofBoxes:makeRoofBoxes(dm.w,dm.d,dm.h),version:0});}
  
      function generateCity(){buildings=[];var cc={x:0,z:2200};
        for(var xi=-7;xi<=7;xi++){for(var zi=0;zi<=32;zi++){
          var bx=xi*ST_PITCH,bz=zi*ST_PITCH+BLK_INNER/2,dx=bx-cc.x,dz=bz-cc.z,rd=Math.sqrt(dx*dx+dz*dz);
          var xE=Math.max(0,(Math.abs(xi)-3)/4),lE=Math.max(0,(-xi-2)/5),fO=Math.max(0,(rd-1800)/1400);
          if(Math.random()<xE*0.38+lE*0.32+fO*0.08)continue;var isC=rd<380;
          var xMin=bx-BLK_INNER/2+ST_SETBACK,xMax=bx+BLK_INNER/2-ST_SETBACK;
          var zMin=zi*ST_PITCH+ST_GAP/2+ST_SETBACK,zMax=(zi+1)*ST_PITCH-ST_GAP/2-ST_SETBACK;
          var tC=Math.max(1,Math.round((isC?randInt(5,7):rd<720?randInt(4,6):randInt(2,4))*(1-xE*0.55)*(1-lE*0.5)));
          var bp=[],att=0;
          while(bp.length<tC&&att<tC*28){att++;var tp=pickType(rd);
            if(bp.filter(function(i){return i.type==="tower";}).length>2&&tp==="tower")tp="midrise";
            var dm=dimsForType(tp),hw=dm.w/2,hd=dm.d/2;
            var xlo=xMin+hw,xhi=xMax-hw,zlo=zMin+hd,zhi=zMax-hd;if(xlo>xhi||zlo>zhi)continue;
            var c=createBuilding({x:rand(xlo,xhi)+rand(-6,6),z:rand(zlo,zhi)+rand(-6,6),w:dm.w,d:dm.d,h:dm.h,type:tp,
              hot:false,hotPhase:rand(0,Math.PI*2),hotEndsAt:0,infectedAt:0,nextArcAt:0,flickerStart:0,
              seedTone:Math.floor(rand(0,8)),floorH:rand(9,14),roofBoxes:makeRoofBoxes(dm.w,dm.d,dm.h),version:0});
            if(!placementIsClear(c,bp,8))continue;bp.push(c);buildings.push(c);}}}
        var now=performance.now();
        var ls=buildings.filter(function(b){return b.x<cameraX&&b.z>180&&b.z<900;});
        var rs=buildings.filter(function(b){return b.x>=cameraX&&b.z>180&&b.z<900;});
        for(var i=0;i<TARGET_HOT/2;i++){if(!ls.length||!rs.length)break;
          activate(ls.splice(Math.floor(Math.random()*ls.length),1)[0],now);
          activate(rs.splice(Math.floor(Math.random()*rs.length),1)[0],now);}}
  
      function activate(b,now){if(!b||b.hot)return;var d=b.z-cameraZ;if(d<160||d>1200)return;
        b.hot=true;b.hotPhase=Math.random()*Math.PI*2;b.flickerStart=now;b.hotEndsAt=Infinity;b.infectedAt=now;b.nextArcAt=now+rand(900,1800);}
      function markImpact(b,now){if(!b)return;b.impactAt=now;b.impactPhase=Math.random()*Math.PI*2;b.flickerStart=now-400;}
  
      function maybeSpawnArc(now){var lc=arcs.length;if(lc>=TARGET_ARCS)return;sourceList.length=0;
        for(var i=0;i<buildings.length;i++){var b=buildings[i],dz=b.z-cameraZ;
          if(b.hot&&visualHot(b)&&b.nextArcAt&&now>=b.nextArcAt&&dz>=160&&dz<=ARC_FAR_MAX)sourceList.push(b);}
        sourceList.sort(function(a,b){return(a.z-cameraZ)-(b.z-cameraZ);});
        for(var i=0;i<sourceList.length&&lc<TARGET_ARCS;i++){var src=sourceList[i];targetList.length=0;
          for(var k=0;k<buildings.length;k++){var bb=buildings[k],fw=bb.z-src.z,lat=Math.abs(bb.x-src.x),cd=bb.z-cameraZ;
            if(!bb.hot&&bb!==src&&fw>=420&&fw<=1150&&lat>=80&&lat<=Math.max(220,fw*0.58)&&cd>ARC_NEAR_MAX&&cd<1200)targetList.push(bb);}
          if(!targetList.length){src.nextArcAt=now+rand(900,1600);continue;}
          targetList.sort(function(a,b){var af=a.z-src.z,bf=b.z-src.z;return(Math.abs(Math.abs(a.x-src.x)/af-0.36)-af/2600)-(Math.abs(Math.abs(b.x-src.x)/bf-0.36)-bf/2600);});
          var fan=Math.min(targetList.length,Math.random()<0.35?2:1);
          for(var j=0;j<fan&&lc<TARGET_ARCS;j++){var dst=targetList[j];
            var ax=src.x,ay=src.h,az=src.z,bx2=dst.x,by2=dst.h,bz2=dst.z;
            var mx=(ax+bx2)/2,mz=(az+bz2)/2,d2=Math.hypot(ax-bx2,az-bz2),my=Math.max(ay,by2)+Math.min(d2*0.95,620);
            arcs.push({a:src,b:dst,ax:ax,ay:ay,az:az,mx:mx,my:my,mz:mz,bx:bx2,by:by2,bz:bz2,
              startedAt:now,pulseDuration:rand(1500,2500),lifetime:rand(4200,7000),arrivedAt:0,bloomAt:0,bloomDone:false,delivered:false,dotRadius:rand(5,7),
              aP:{x:0,y:0,depth:0,visible:false},bP:{x:0,y:0,depth:0,visible:false},pP:{x:0,y:0,depth:0,visible:false},
              lastPulseX:-9999,lastPulseY:-9999,lastEndpointX:-9999,lastEndpointY:-9999});lc++;}
          src.nextArcAt=now+rand(2600,5200);}}
      function updateArcs(now){var w=0;for(var i=0;i<arcs.length;i++){var a=arcs[i],el=now-a.startedAt,t=Math.min(1,el/a.pulseDuration);
        if(cameraDepth(a.ax,a.ay,a.az)<NEAR_PLANE&&cameraDepth(a.mx,a.my,a.mz)<NEAR_PLANE&&cameraDepth(a.bx,a.by,a.bz)<NEAR_PLANE)continue;
        if(t>=1&&!a.delivered){a.delivered=true;a.arrivedAt=now;a.bloomAt=now;activate(a.b,now);markImpact(a.b,now);}
        if(a.arrivedAt&&now-a.arrivedAt>a.lifetime+500)continue;arcs[w++]=a;}arcs.length=w;}
  
      function generateParticles(){particles=[];for(var i=0;i<120;i++)particles.push({x:rand(0,W),y:rand(0,H*0.5),r:rand(0.5,1.5),a:rand(0.1,0.4)});}
      function drawParticles(){if(!particleCtx)return;particleCtx.clearRect(0,0,W,H);particleCtx.save();particleCtx.fillStyle="#aabbdd";
        for(var i=0;i<particles.length;i++){var p=particles[i];particleCtx.globalAlpha=p.a;particleCtx.beginPath();particleCtx.arc(p.x,p.y,p.r,0,Math.PI*2);particleCtx.fill();}
        particleCtx.globalAlpha=1;particleCtx.restore();}
      function updateQuality(dt,now){var fps=dt>0?1/dt:60;fpsSamples[fpsSampleIndex]=fps;fpsSampleIndex=(fpsSampleIndex+1)%fpsSamples.length;
        fpsSampleCount=Math.min(fpsSampleCount+1,fpsSamples.length);var tot=0;for(var i=0;i<fpsSampleCount;i++)tot+=fpsSamples[i];fpsAverage=tot/fpsSampleCount;
        if(fpsAverage<40){qualityLevel=2;qualityRestoreStarted=0;}else if(fpsAverage<50&&qualityLevel<1){qualityLevel=1;qualityRestoreStarted=0;}
        else if(fpsAverage>58){if(!qualityRestoreStarted)qualityRestoreStarted=now;if(now-qualityRestoreStarted>5000)qualityLevel=0;}
        else qualityRestoreStarted=0;renderCap=Infinity;windowDensityScale=2;}
      function recycleAndUpdate(now){for(var i=0;i<buildings.length;i++){var b=buildings[i];
        if(b.z+b.d/2-cameraZ<-120){var rep=null;for(var a=0;a<24&&!rep;a++){var zi=Math.floor((cameraZ+rand(3200,8200))/ST_PITCH),xi=randInt(-7,7);
          var c=makeBuildingInCell(xi,zi);if(c&&placementIsClear(c,buildings,10,b))rep=c;}
          if(rep){b.x=rep.x;b.z=rep.z;b.w=rep.w;b.d=rep.d;b.h=rep.h;b.type=rep.type;b.hot=false;
            b.hotPhase=rep.hotPhase;b.hotEndsAt=0;b.infectedAt=0;b.nextArcAt=0;b.flickerStart=0;b.impactAt=0;b.impactPhase=0;
            b.seedTone=rep.seedTone;b.floorH=rep.floorH;b.roofBoxes=rep.roofBoxes;setBuildingGeometry(b);b.version=(b.version||0)+1;}}}}
  
      /* ═══ GEOMETRY BUILDERS ═══ */
      function pQ(buf,o,ax,ay,bx,by,cx,cy,dx,dy,r,g,b,a){
        buf[o]=ax;buf[o+1]=ay;buf[o+2]=r;buf[o+3]=g;buf[o+4]=b;buf[o+5]=a;
        buf[o+6]=bx;buf[o+7]=by;buf[o+8]=r;buf[o+9]=g;buf[o+10]=b;buf[o+11]=a;
        buf[o+12]=cx;buf[o+13]=cy;buf[o+14]=r;buf[o+15]=g;buf[o+16]=b;buf[o+17]=a;
        buf[o+18]=ax;buf[o+19]=ay;buf[o+20]=r;buf[o+21]=g;buf[o+22]=b;buf[o+23]=a;
        buf[o+24]=cx;buf[o+25]=cy;buf[o+26]=r;buf[o+27]=g;buf[o+28]=b;buf[o+29]=a;
        buf[o+30]=dx;buf[o+31]=dy;buf[o+32]=r;buf[o+33]=g;buf[o+34]=b;buf[o+35]=a;return o+36;}
      function pGQ(buf,o,ax,ay,ar,ag,ab,aa,bx,by,br,bg,bb,ba,cx,cy,cr,cg,cb,ca,dx,dy,dr,dg,db,da){
        buf[o]=ax;buf[o+1]=ay;buf[o+2]=ar;buf[o+3]=ag;buf[o+4]=ab;buf[o+5]=aa;
        buf[o+6]=bx;buf[o+7]=by;buf[o+8]=br;buf[o+9]=bg;buf[o+10]=bb;buf[o+11]=ba;
        buf[o+12]=cx;buf[o+13]=cy;buf[o+14]=cr;buf[o+15]=cg;buf[o+16]=cb;buf[o+17]=ca;
        buf[o+18]=ax;buf[o+19]=ay;buf[o+20]=ar;buf[o+21]=ag;buf[o+22]=ab;buf[o+23]=aa;
        buf[o+24]=cx;buf[o+25]=cy;buf[o+26]=cr;buf[o+27]=cg;buf[o+28]=cb;buf[o+29]=ca;
        buf[o+30]=dx;buf[o+31]=dy;buf[o+32]=dr;buf[o+33]=dg;buf[o+34]=db;buf[o+35]=da;return o+36;}
      function pL(buf,o,x0,y0,x1,y1,w,r,g,b,a){var dx=x1-x0,dy=y1-y0,l=Math.sqrt(dx*dx+dy*dy);if(l<.001)return o;
        var hw=w*.5,nx=(-dy/l)*hw,ny=(dx/l)*hw;return pQ(buf,o,x0+nx,y0+ny,x0-nx,y0-ny,x1-nx,y1-ny,x1+nx,y1+ny,r,g,b,a);}
      function pRG(buf,o,cx,cy,rad,r,g,b,ia){for(var i=0;i<16;i++){var a0=(i/16)*Math.PI*2,a1=((i+1)/16)*Math.PI*2;
        buf[o]=cx;buf[o+1]=cy;buf[o+2]=r;buf[o+3]=g;buf[o+4]=b;buf[o+5]=ia;o+=6;
        buf[o]=cx+Math.cos(a0)*rad;buf[o+1]=cy+Math.sin(a0)*rad;buf[o+2]=r;buf[o+3]=g;buf[o+4]=b;buf[o+5]=0;o+=6;
        buf[o]=cx+Math.cos(a1)*rad;buf[o+1]=cy+Math.sin(a1)*rad;buf[o+2]=r;buf[o+3]=g;buf[o+4]=b;buf[o+5]=0;o+=6;}return o;}
      function pDot(buf,o,cx,cy,rad,r,g,b,a){return pQ(buf,o,cx-rad,cy-rad,cx+rad,cy-rad,cx+rad,cy+rad,cx-rad,cy+rad,r,g,b,a);}
      function pushP(buf,idx,x,y,sz,r,g,b,a){var o=idx*S7;buf[o]=x;buf[o+1]=y;buf[o+2]=sz;buf[o+3]=r;buf[o+4]=g;buf[o+5]=b;buf[o+6]=a;return idx+1;}
  
      function drawStreetGrid(){var rb=gridCacheDirty||frameCount%3===0||!gridMajorPath||!gridMinorPath;
        if(rb){gridMajorPath=new Path2D();gridMinorPath=new Path2D();
          var zS=Math.floor(cameraZ/ST_PITCH)*ST_PITCH-ST_PITCH;
          for(var z=zS;z<cameraZ+GRID_EXTENT;z+=ST_PITCH){for(var oi=0;oi<2;oi++){var off=oi===0?-ST_GAP/2:ST_GAP/2;
            if(projectInto(-GRID_HALF_W,0,z+off,_p0)&&projectInto(GRID_HALF_W,0,z+off,_p1)){gridMajorPath.moveTo(_p0.x,_p0.y);gridMajorPath.lineTo(_p1.x,_p1.y);}}}
          for(var xi=-7;xi<=8;xi++){var xv=xi*ST_PITCH;for(var oi=0;oi<2;oi++){var xp=xv+(oi===0?-ST_GAP/2:ST_GAP/2);
            if(projectInto(xp,0,cameraZ,_p0)&&projectInto(xp,0,cameraZ+GRID_EXTENT,_p1)){gridMajorPath.moveTo(_p0.x,_p0.y);gridMajorPath.lineTo(_p1.x,_p1.y);}}}
          var mz=Math.floor(cameraZ/60)*60-60;
          for(var z=mz;z<cameraZ+GRID_EXTENT;z+=60){if(projectInto(-GRID_HALF_W,0,z,_p0)&&projectInto(GRID_HALF_W,0,z,_p1)){gridMinorPath.moveTo(_p0.x,_p0.y);gridMinorPath.lineTo(_p1.x,_p1.y);}}
          for(var x=-GRID_HALF_W;x<=GRID_HALF_W;x+=60){if(projectInto(x,0,cameraZ,_p0)&&projectInto(x,0,cameraZ+GRID_EXTENT,_p1)){gridMinorPath.moveTo(_p0.x,_p0.y);gridMinorPath.lineTo(_p1.x,_p1.y);}}
          gridCacheDirty=false;}
        if(rb||frameCount%2===0){gridCtx.clearRect(0,0,W,H);gridCtx.save();
          gridCtx.strokeStyle="rgba(26,58,90,0.4)";gridCtx.shadowColor="#1a4a8a";gridCtx.shadowBlur=4;gridCtx.lineWidth=0.5;gridCtx.stroke(gridMajorPath);
          gridCtx.shadowBlur=0;gridCtx.strokeStyle="rgba(26,58,90,0.15)";gridCtx.lineWidth=0.5;gridCtx.stroke(gridMinorPath);gridCtx.restore();
          gridCtx.save();gridCtx.globalCompositeOperation="destination-in";
          var fogMask=gridCtx.createLinearGradient(0,H*.28,0,H*.62);
          fogMask.addColorStop(0,"rgba(0,0,0,0)");fogMask.addColorStop(.52,"rgba(0,0,0,0)");fogMask.addColorStop(1,"rgba(0,0,0,1)");
          gridCtx.fillStyle=fogMask;gridCtx.fillRect(0,0,W,H);gridCtx.restore();
          gridCtx.save();gridCtx.font='11px "DM Mono",monospace';gridCtx.fillStyle="#444";
          gridCtx.fillText(Math.round(1/Math.max(smoothDelta,.001))+" fps",10,20);gridCtx.restore();}}
  
      function buildWindowDots(win,lb,rb,rt,lt,hot,fog,dist){if(!win||!win.length)return;
        var farT=clamp((dist-900)/4200,0,1),dO=1-clamp((dist-900)/5200,0,.66),fO=Math.min(1,(1-fog*.62)*dO*(.68+farT*.54)),step=windowDensityScale;
        var winScale=clamp(1.18-(dist-480)/3000,.48,1.18);
        var o=sceneN*S6,buf=sceneBuf;
        var nr,ng,nb;if(hot){nr=1;ng=.46;nb=.28;}else{nr=.9;ng=.96;nb=1;}
        for(var i=0;i<win.length;i+=step){var w=win[i];if(w.bright)continue;
          var lx=lb.x+(lt.x-lb.x)*w.v,ly=lb.y+(lt.y-lb.y)*w.v,rx=rb.x+(rt.x-rb.x)*w.v,ry=rb.y+(rt.y-rb.y)*w.v;
          var wx=lx+(rx-lx)*w.u,wy=ly+(ry-ly)*w.u;o=pDot(buf,o,wx,wy,1.35*winScale,nr,ng,nb,(hot?.94:1)*fO);}
        var br2,bg2,bb2;if(hot){br2=1;bg2=.66;bb2=.46;}else{br2=1;bg2=1;bb2=1;}
        for(var i=0;i<win.length;i+=step){var w=win[i];if(!w.bright)continue;
          var lx=lb.x+(lt.x-lb.x)*w.v,ly=lb.y+(lt.y-lb.y)*w.v,rx=rb.x+(rt.x-rb.x)*w.v,ry=rb.y+(rt.y-rb.y)*w.v;
          var wx=lx+(rx-lx)*w.u,wy=ly+(ry-ly)*w.u;o=pDot(buf,o,wx,wy,1.9*winScale,br2,bg2,bb2,(hot?.95:1)*fO);}
        if(hot){for(var i=0;i<win.length;i+=Math.max(step,5)){var w=win[i];
          var lx=lb.x+(lt.x-lb.x)*w.v,ly=lb.y+(lt.y-lb.y)*w.v,rx=rb.x+(rt.x-rb.x)*w.v,ry=rb.y+(rt.y-rb.y)*w.v;
          var wx=lx+(rx-lx)*w.u,wy=ly+(ry-ly)*w.u;o=pDot(buf,o,wx,wy,1.7*winScale,1,.78,.62,.96*fO);}}
        sceneN=o/S6;}
  
      function buildBuildingGeometry(b,now){
        var s=b.screen,fl=s[0],fr=s[1],br2=s[2],bl=s[3],tfl=s[4],tfr=s[5],tbr=s[6],tbl=s[7];
        var dist=b.z-cameraZ,hot=b.drawHot,fog=fogForBuilding(b),mix=fog*.85;
        var hw=b.w/2,hd=b.d/2,x0=b.x-hw,x1=b.x+hw,z0=b.z-hd,z1=b.z+hd,midY=b.h*.5;
        var fade=distanceFade(b);if(fade<=0)return;
        var fR,fG,fB,fA,sR,sG,sB,sA,tR,tG,tB,tA,eR,eG,eB,eA,teR,teG,teB,teA;
        if(hot){var fT=Math.min(1,(now-b.flickerStart)/400),pul=.85+.15*Math.sin((now/900)*Math.PI+b.hotPhase),al=fT*pul*fade;
          fR=(.627)*(1-mix)+(.027)*mix;fG=(.165)*(1-mix)+(.039)*mix;fB=(.047)*(1-mix)+(.063)*mix;fA=al;
          sR=(.51)*(1-mix)+(.027)*mix;sG=(.133)*(1-mix)+(.039)*mix;sB=(.039)*(1-mix)+(.063)*mix;sA=al;
          tR=(.86)*(1-mix)+(.027)*mix;tG=(.314)*(1-mix)+(.039)*mix;tB=(.137)*(1-mix)+(.063)*mix;tA=al;
          eR=1;eG=.45;eB=.28;eA=Math.max(.5,.85*al);teR=1;teG=.58;teB=.38;teA=Math.max(.65,al);
        }else{fR=fogBlend(b.baseFrontR,7,mix);fG=fogBlend(b.baseFrontG,10,mix);fB=fogBlend(b.baseFrontB,16,mix);fA=fade;
          sR=fogBlend(b.baseSideR,7,mix);sG=fogBlend(b.baseSideG,10,mix);sB=fogBlend(b.baseSideB,16,mix);sA=fade;
          tR=fogBlend(b.baseTopR,7,mix);tG=fogBlend(b.baseTopG,10,mix);tB=fogBlend(b.baseTopB,16,mix);tA=fade;
          eR=80/255;eG=110/255;eB=150/255;eA=.14*fade;teR=100/255;teG=140/255;teB=185/255;teA=.22*fade;}
        var o=sceneN*S6,buf=sceneBuf;
        var showBack=faceVisible(0,0,1,b.x,midY,z1);
        if(showBack)o=pQ(buf,o,br2.x,br2.y,bl.x,bl.y,tbl.x,tbl.y,tbr.x,tbr.y,sR,sG,sB,sA);
        if(!hot&&showBack){var brg=24/255,bgg=42/255,bbg=78/255,bbA=.36*(1-fog*.85)*fade,btA=.12*(1-fog*.85)*fade;
          o=pGQ(buf,o,br2.x,br2.y,brg,bgg,bbg,bbA,bl.x,bl.y,brg,bgg,bbg,bbA,tbl.x,tbl.y,brg,bgg,bbg,btA,tbr.x,tbr.y,brg,bgg,bbg,btA);}
        var showLeft=faceVisible(-1,0,0,x0,midY,b.z);
        if(showLeft)o=pQ(buf,o,bl.x,bl.y,fl.x,fl.y,tfl.x,tfl.y,tbl.x,tbl.y,sR,sG,sB,sA);
        if(!hot&&showLeft){var lr=26/255,lg=44/255,lb=82/255,lbA=.44*(1-fog*.85)*fade,ltA=.16*(1-fog*.85)*fade;
          o=pGQ(buf,o,bl.x,bl.y,lr,lg,lb,lbA,fl.x,fl.y,lr,lg,lb,lbA,tfl.x,tfl.y,lr,lg,lb,ltA,tbl.x,tbl.y,lr,lg,lb,ltA);}
        var showF=faceVisible(0,0,-1,b.x,midY,z0);
        if(showF)o=pQ(buf,o,fl.x,fl.y,fr.x,fr.y,tfr.x,tfr.y,tfl.x,tfl.y,fR,fG,fB,fA);
        if(!hot&&showF){var gr=30/255,gg=52/255,gb=92/255,bA=.82*(1-fog*.85)*fade,mA=.34*(1-fog*.85)*fade;
          var t4=.4,m0x=fl.x+(tfl.x-fl.x)*t4,m0y=fl.y+(tfl.y-fl.y)*t4,m1x=fr.x+(tfr.x-fr.x)*t4,m1y=fr.y+(tfr.y-fr.y)*t4;
          o=pGQ(buf,o,fl.x,fl.y,gr,gg,gb,bA,fr.x,fr.y,gr,gg,gb,bA,m1x,m1y,gr,gg,gb,mA,m0x,m0y,gr,gg,gb,mA);
          o=pGQ(buf,o,m0x,m0y,gr,gg,gb,mA,m1x,m1y,gr,gg,gb,mA,tfr.x,tfr.y,gr,gg,gb,0,tfl.x,tfl.y,gr,gg,gb,0);}
        var showR=faceVisible(1,0,0,x1,midY,b.z);
        if(showR)o=pQ(buf,o,fr.x,fr.y,br2.x,br2.y,tbr.x,tbr.y,tfr.x,tfr.y,sR,sG,sB,sA);
        if(!hot&&showR){var sr=28/255,sg=46/255,sb=82/255,sbA=.48*(1-fog*.85)*fade,smA=.18*(1-fog*.85)*fade;
          var st4=.45,sm0x=fr.x+(tfr.x-fr.x)*st4,sm0y=fr.y+(tfr.y-fr.y)*st4,sm1x=br2.x+(tbr.x-br2.x)*st4,sm1y=br2.y+(tbr.y-br2.y)*st4;
          o=pGQ(buf,o,fr.x,fr.y,sr,sg,sb,sbA,br2.x,br2.y,sr,sg,sb,sbA,sm1x,sm1y,sr,sg,sb,smA,sm0x,sm0y,sr,sg,sb,smA);}
        o=pQ(buf,o,tfl.x,tfl.y,tfr.x,tfr.y,tbr.x,tbr.y,tbl.x,tbl.y,tR,tG,tB,tA);
        if(!hot&&b.h>58){var ph=9;if(projectInto(x0,0,z0,_p0)&&projectInto(x1,0,z0,_p1)&&projectInto(x0,ph,z0,_p2)&&projectInto(x1,ph,z0,_p3))
          o=pQ(buf,o,_p0.x,_p0.y,_p1.x,_p1.y,_p3.x,_p3.y,_p2.x,_p2.y,28/255,37/255,53/255,.9*fade);}
        var lw=hot?1.2:.7;
        o=pL(buf,o,tfl.x,tfl.y,tfr.x,tfr.y,lw,teR,teG,teB,teA);o=pL(buf,o,tfr.x,tfr.y,tbr.x,tbr.y,lw,teR,teG,teB,teA);
        o=pL(buf,o,tbr.x,tbr.y,tbl.x,tbl.y,lw,teR,teG,teB,teA);o=pL(buf,o,tbl.x,tbl.y,tfl.x,tfl.y,lw,teR,teG,teB,teA);
        if(hot&&b.impactAt){var ie=now-b.impactAt;if(ie>=0&&ie<1400&&projectInto(b.x,b.h,b.z,_p0)){
          var it=ie/1400,ia=(.6+.4*clamp(ie/120,0,1))*Math.pow(1-it,2.2)*fade,ring=36+it*210,pulse=1+.24*Math.sin(ie*.04+(b.impactPhase||0));
          o=pQ(buf,o,tfl.x,tfl.y,tfr.x,tfr.y,tbr.x,tbr.y,tbl.x,tbl.y,1,.45,.24,.46*ia);
          o=pRG(buf,o,_p0.x,_p0.y,ring,1,.36,.14,.76*ia);
          o=pRG(buf,o,_p0.x,_p0.y,Math.max(18,ring*.42),1,.86,.58,1*ia);
          o=pL(buf,o,tfl.x,tfl.y,tbr.x,tbr.y,4.8*pulse,1,.72,.42,.9*ia);
          o=pL(buf,o,tfr.x,tfr.y,tbl.x,tbl.y,4.8*pulse,1,.72,.42,.9*ia);
          o=pL(buf,o,tfl.x,tfl.y,tfr.x,tfr.y,3.2*pulse,1,.86,.58,.78*ia);
          o=pL(buf,o,tbl.x,tbl.y,tbr.x,tbr.y,3.2*pulse,1,.86,.58,.62*ia);
          if(projectInto(b.x,0,b.z,_p1)){o=pL(buf,o,_p0.x,_p0.y,_p1.x,_p1.y,6.2,1,.38,.16,.78*ia);
            o=pL(buf,o,tfl.x,tfl.y,fl.x,fl.y,2.8,1,.72,.42,.52*ia);o=pL(buf,o,tfr.x,tfr.y,fr.x,fr.y,2.8,1,.72,.42,.52*ia);}
        }}
        if(dist<5200){var rR,rG,rB,rA;if(hot){rR=1;rG=.65;rB=.48;rA=.28*fade;}else{rR=145/255;rG=178/255;rB=228/255;rA=.13*fade;}
          var rxL=Math.max(1,Math.floor(b.w/42));for(var i=1;i<=rxL;i++){var t=i/(rxL+1);
            o=pL(buf,o,tfl.x+(tfr.x-tfl.x)*t,tfl.y+(tfr.y-tfl.y)*t,tbl.x+(tbr.x-tbl.x)*t,tbl.y+(tbr.y-tbl.y)*t,.5,rR,rG,rB,rA);}
          var rzL=Math.max(1,Math.floor(b.d/48));for(var i=1;i<=rzL;i++){var t=i/(rzL+1);
            o=pL(buf,o,tfl.x+(tbl.x-tfl.x)*t,tfl.y+(tbl.y-tfl.y)*t,tfr.x+(tbr.x-tfr.x)*t,tfr.y+(tbr.y-tfr.y)*t,.5,rR,rG,rB,rA);}}
        if(dist<5600){var ga=Math.max(.04,.22-dist/9500)*fade;var fR2,fG2,fB2,fA2;
          if(hot){fR2=58/255;fG2=17/255;fB2=17/255;fA2=Math.max(.18,ga);}else{fR2=145/255;fG2=178/255;fB2=228/255;fA2=ga;}
          var fH=b.floorH||11,fC=Math.max(1,Math.floor(b.h/fH));
          for(var i=1;i<fC;i++){var t=i/fC;o=pL(buf,o,fl.x+(tfl.x-fl.x)*t,fl.y+(tfl.y-fl.y)*t,fr.x+(tfr.x-fr.x)*t,fr.y+(tfr.y-fr.y)*t,.5,fR2,fG2,fB2,fA2);}
          if(showF){var bC=Math.max(1,Math.floor(b.w/17));for(var i=1;i<bC;i++){var t=i/bC;
            o=pL(buf,o,fl.x+(fr.x-fl.x)*t,fl.y+(fr.y-fl.y)*t,tfl.x+(tfr.x-tfl.x)*t,tfl.y+(tfr.y-tfl.y)*t,.5,fR2,fG2,fB2,fA2);}}
          for(var i=1;i<fC;i++){var t=i/fC;o=pL(buf,o,fr.x+(tfr.x-fr.x)*t,fr.y+(tfr.y-fr.y)*t,br2.x+(tbr.x-br2.x)*t,br2.y+(tbr.y-br2.y)*t,.5,fR2,fG2,fB2,fA2);}
          if(showR){var bD=Math.max(1,Math.floor(b.d/17));for(var i=1;i<bD;i++){var t=i/bD;
            o=pL(buf,o,fr.x+(br2.x-fr.x)*t,fr.y+(br2.y-fr.y)*t,tfr.x+(tbr.x-tfr.x)*t,tfr.y+(tbr.y-tfr.y)*t,.5,fR2,fG2,fB2,fA2);}}}
        sceneN=o/S6;
        if(dist<6200&&b.h>40){if(showF)buildWindowDots(b.frontWindows,fl,fr,tfr,tfl,hot,fog,dist);if(showR)buildWindowDots(b.sideWindows,fr,br2,tbr,tfr,hot,fog,dist);}
        if(dist<1800&&b.roofBoxes&&b.roofBoxes.length){o=sceneN*S6;
          for(var bi=0;bi<b.roofBoxes.length;bi++){var bx=b.roofBoxes[bi];
            var bx0=b.x+bx.rx-bx.rw/2,bx1=b.x+bx.rx+bx.rw/2,bz0=b.z+bx.rz-bx.rd/2,bz1=b.z+bx.rz+bx.rd/2,by0=b.h,by1=b.h+bx.rh;
            var rs=bx.screen;if(!projectInto(bx0,by0,bz0,rs[0])||!projectInto(bx1,by0,bz0,rs[1])||!projectInto(bx0,by1,bz0,rs[2])||!projectInto(bx1,by1,bz0,rs[3])||
              !projectInto(bx1,by1,bz1,rs[4])||!projectInto(bx0,by1,bz1,rs[5])||!projectInto(bx0,by0,bz1,rs[6])||!projectInto(bx1,by0,bz1,rs[7]))continue;
            var rf,rg,rb3,rlR,rlG,rlB,rrR,rrG,rrB,rtR,rtG,rtB;
            if(hot){rf=.43;rg=.12;rb3=.055;rlR=.55;rlG=.15;rlB=.07;rrR=.47;rrG=.13;rrB=.063;rtR=.78;rtG=.31;rtB=.16;}
            else{rf=fogBlend(b.roofFrontR,7,mix);rg=fogBlend(b.roofFrontG,10,mix);rb3=fogBlend(b.roofFrontB,16,mix);
              rlR=fogBlend(b.roofLeftR,7,mix);rlG=fogBlend(b.roofLeftG,10,mix);rlB=fogBlend(b.roofLeftB,16,mix);
              rrR=fogBlend(b.roofRightR,7,mix);rrG=fogBlend(b.roofRightG,10,mix);rrB=fogBlend(b.roofRightB,16,mix);
              rtR=fogBlend(b.roofTopR,7,mix);rtG=fogBlend(b.roofTopG,10,mix);rtB=fogBlend(b.roofTopB,16,mix);}
            var ra=hot?.92*fade:fade;
            o=pQ(buf,o,rs[0].x,rs[0].y,rs[1].x,rs[1].y,rs[3].x,rs[3].y,rs[2].x,rs[2].y,rf,rg,rb3,ra);
            o=pQ(buf,o,rs[6].x,rs[6].y,rs[0].x,rs[0].y,rs[2].x,rs[2].y,rs[5].x,rs[5].y,rlR,rlG,rlB,hot?.9*fade:fade);
            o=pQ(buf,o,rs[1].x,rs[1].y,rs[7].x,rs[7].y,rs[4].x,rs[4].y,rs[3].x,rs[3].y,rrR,rrG,rrB,hot?.9*fade:fade);
            o=pQ(buf,o,rs[2].x,rs[2].y,rs[3].x,rs[3].y,rs[4].x,rs[4].y,rs[5].x,rs[5].y,rtR,rtG,rtB,hot?.92*fade:fade);
            var reR=hot?1:120/255,reG=hot?.68:155/255,reB=hot?.52:205/255,reA=hot?.45*fade:.22*fade;
            o=pL(buf,o,rs[0].x,rs[0].y,rs[1].x,rs[1].y,.5,reR,reG,reB,reA);o=pL(buf,o,rs[1].x,rs[1].y,rs[3].x,rs[3].y,.5,reR,reG,reB,reA);
            o=pL(buf,o,rs[3].x,rs[3].y,rs[2].x,rs[2].y,.5,reR,reG,reB,reA);o=pL(buf,o,rs[2].x,rs[2].y,rs[0].x,rs[0].y,.5,reR,reG,reB,reA);}
          sceneN=o/S6;}
        o=sceneN*S6;var cew=hot?1:.5;
        o=pL(buf,o,fl.x,fl.y,tfl.x,tfl.y,cew,eR,eG,eB,eA);o=pL(buf,o,tfr.x,tfr.y,fr.x,fr.y,cew,eR,eG,eB,eA);
        o=pL(buf,o,tfr.x,tfr.y,tbr.x,tbr.y,cew,eR,eG,eB,eA);o=pL(buf,o,bl.x,bl.y,tbl.x,tbl.y,cew,eR,eG,eB,eA);
        o=pL(buf,o,br2.x,br2.y,tbr.x,tbr.y,cew,eR,eG,eB,eA);sceneN=o/S6;
        if(hot){o=sceneN*S6;if(projectInto(b.x,0,b.z,b.miscProj)){var nf=clamp((b.z-cameraZ-55)/105,0,1);
          if(nf>0){var rad=Math.max(42,Math.min(170,((Math.max(b.w,b.d)*1.35*FOCAL)/Math.max(b.miscProj.depth,1))*.5));
            o=pRG(buf,o,b.miscProj.x,b.miscProj.y,rad,1,.2,.04,.34*nf*fade);}}sceneN=o/S6;}}
  
      function buildArcTrailSegment(arc,t0,t1,alpha){
        arcPointInto(arc,t0,_p0);arcPointInto(arc,t1,_p2);var sp=t1-t0;
        var dx0=(1-t0)*(arc.mx-arc.ax)+t0*(arc.bx-arc.mx),dy0=(1-t0)*(arc.my-arc.ay)+t0*(arc.by-arc.my),dz0=(1-t0)*(arc.mz-arc.az)+t0*(arc.bz-arc.mz);
        _p1.x=_p0.x+sp*dx0;_p1.y=_p0.y+sp*dy0;_p1.z=_p0.z+sp*dz0;
        if(!projectInto(_p0.x,_p0.y,_p0.z,_p0)||!projectInto(_p1.x,_p1.y,_p1.z,_p1)||!projectInto(_p2.x,_p2.y,_p2.z,_p2))return;
        var o=sceneN*S6;
        for(var i=0;i<10;i++){var ta=i/10,tb=(i+1)/10;
          var ax=_p0.x*(1-ta)*(1-ta)+_p1.x*2*(1-ta)*ta+_p2.x*ta*ta,ay=_p0.y*(1-ta)*(1-ta)+_p1.y*2*(1-ta)*ta+_p2.y*ta*ta;
          var bx2=_p0.x*(1-tb)*(1-tb)+_p1.x*2*(1-tb)*tb+_p2.x*tb*tb,by2=_p0.y*(1-tb)*(1-tb)+_p1.y*2*(1-tb)*tb+_p2.y*tb*tb;
          var dx=bx2-ax,dy=by2-ay,dl=Math.sqrt(dx*dx+dy*dy);if(dl>.001){var ox=dx/dl*.65,oy=dy/dl*.65;ax-=ox;ay-=oy;bx2+=ox;by2+=oy;}
          o=pL(sceneBuf,o,ax,ay,bx2,by2,7,1,.36,.14,.105*alpha);
          o=pL(sceneBuf,o,ax,ay,bx2,by2,3.6,1,.86,.58,.54*alpha);
          o=pL(sceneBuf,o,ax,ay,bx2,by2,.8,1,.933,.933,.95*alpha);}
        sceneN=o/S6;}
  
      function buildArcDot(arc,now){var el=now-arc.startedAt,tT=Math.min(1,el/arc.pulseDuration);
        var ax=arc.ax,ay=arc.ay,az=arc.az,mx=arc.mx,my=arc.my,mz=arc.mz,bx=arc.bx,by2=arc.by,bz=arc.bz;
        if(cameraDepth(ax,ay,az)<NEAR_PLANE&&cameraDepth(mx,my,mz)<NEAR_PLANE&&cameraDepth(bx,by2,bz)<NEAR_PLANE)return;
        var al=1;if(el<280)al=el/280;if(arc.arrivedAt){var fe=now-arc.arrivedAt-arc.lifetime;if(fe>0)al*=Math.max(0,1-fe/500);}
        var o=sceneN*S6;
        if(projectInto(ax,ay,az,arc.aP)){o=pRG(sceneBuf,o,arc.aP.x,arc.aP.y,17,1,.38,.16,.32*al);
          o=pRG(sceneBuf,o,arc.aP.x,arc.aP.y,5,1,.72,.42,.6*al);}
        var t=tT,om=1-t,px=om*om*ax+2*om*t*mx+t*t*bx,py=om*om*ay+2*om*t*my+t*t*by2,pz=om*om*az+2*om*t*mz+t*t*bz;
        if(projectInto(px,py,pz,arc.pP)&&t<1){o=pRG(sceneBuf,o,arc.pP.x,arc.pP.y,arc.dotRadius*5.6,1,.36,.14,.66*al);
          o=pRG(sceneBuf,o,arc.pP.x,arc.pP.y,arc.dotRadius*2.35,1,.86,.58,.88*al);
          o=pRG(sceneBuf,o,arc.pP.x,arc.pP.y,Math.max(10,arc.dotRadius*1.75),1,.96,.9,.98*al);}
        if(arc.bloomAt&&projectInto(bx,by2,bz,arc.bP)){var bt=(now-arc.bloomAt)/680;if(bt<1){var bf=Math.pow(1-bt,1.7),ps=1+bt*1.45;
          o=pRG(sceneBuf,o,arc.bP.x,arc.bP.y,18*ps,1,.34,.12,.4*bf*al);
          o=pRG(sceneBuf,o,arc.bP.x,arc.bP.y,7*ps,1,.72,.4,.55*bf*al);
          }}
        sceneN=o/S6;}
  
      function arcSegmentDepth(arc,t0,t1){arcPointInto(arc,(t0+t1)*.5,_adp);
        if(projectInto(_adp.x,0,_adp.z,_ads))return _ads.depth;return cameraDepth(_adp.x,0,_adp.z);}
      function arcDotDepth(arc,tT){arcPointInto(arc,tT,_adp);
        if(projectInto(_adp.x,0,_adp.z,_ads))return _ads.depth;return cameraDepth(_adp.x,0,_adp.z);}
  
      function uploadTex(tex,cvs){gl.bindTexture(gl.TEXTURE_2D,tex);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,cvs);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);}
      function drawFSQ(prog,attr){gl.bindBuffer(gl.ARRAY_BUFFER,quadBuf);gl.enableVertexAttribArray(attr);
        gl.vertexAttribPointer(attr,2,gl.FLOAT,false,0,0);gl.drawArrays(gl.TRIANGLE_STRIP,0,4);}
      function flushT(buf,n,vb,va){if(!n)return;gl.bindBuffer(gl.ARRAY_BUFFER,vb);
        gl.bufferData(gl.ARRAY_BUFFER,buf.subarray(0,n*S6),gl.STREAM_DRAW);gl.bindVertexArray(va);gl.drawArrays(gl.TRIANGLES,0,n);gl.bindVertexArray(null);}
      function flushP(buf,n,vb,va){if(!n)return;gl.bindBuffer(gl.ARRAY_BUFFER,vb);
        gl.bufferData(gl.ARRAY_BUFFER,buf.subarray(0,n*S7),gl.STREAM_DRAW);gl.bindVertexArray(va);gl.drawArrays(gl.POINTS,0,n);gl.bindVertexArray(null);}
  
      function renderBloom(){if(!glowN&&!glowPtN)return;
        gl.bindFramebuffer(gl.FRAMEBUFFER,glowFBO.fb);gl.viewport(0,0,bloomW,bloomH);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
        gl.useProgram(progMain);gl.uniform2f(mainUR,W,H);flushT(glowBuf,glowN,glowVbo,vaoGlow);
        gl.useProgram(progPoint);gl.uniform2f(ptUR,W,H);gl.uniform1f(ptUD,dpr);flushP(glowPtBuf,glowPtN,glowPtVbo,vaoGlowPt);
        gl.useProgram(progBlur);
        for(var p=0;p<4;p++){gl.bindFramebuffer(gl.FRAMEBUFFER,blurFBO.fb);gl.viewport(0,0,bloomW,bloomH);
          gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,glowFBO.tex);
          gl.uniform1i(blurUT,0);gl.uniform2f(blurUD,1.0/bloomW,0);gl.disable(gl.BLEND);drawFSQ(progBlur,blurAP);
          gl.bindFramebuffer(gl.FRAMEBUFFER,glowFBO.fb);gl.viewport(0,0,bloomW,bloomH);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
          gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,blurFBO.tex);gl.uniform1i(blurUT,0);gl.uniform2f(blurUD,0,1.0/bloomH);
          gl.disable(gl.BLEND);drawFSQ(progBlur,blurAP);}
        gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,Math.floor(W*dpr),Math.floor(H*dpr));
        gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE);gl.useProgram(progTex);gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D,glowFBO.tex);gl.uniform1i(texUT,0);drawFSQ(progTex,texAP);}
  
      function frame(now){if(!running){frameId=null;return;}now=now||performance.now();
        var mi=1000/targetFPS;if(targetFPS<60&&now-lastFrameTime<mi){frameId=raf(frame);return;}
        lastFrameTime=now;var rd=(now-lastTime)/1000,dt=Math.min(rd,.05);smoothDelta=smoothDelta*.9+dt*.1;lastTime=now;frameCount++;
        updateQuality(smoothDelta,now);
        if(!reducedMotion){cameraZ+=DOLLY_SPEED*smoothDelta;cameraX+=CAM_X_DRIFT*smoothDelta;}
        recycleAndUpdate(now);maybeSpawnArc(now);updateArcs(now);drawStreetGrid();
        sceneN=0;glowN=0;screenBlendN=0;pointN=0;glowPtN=0;
        // Fog overlay — fades grid at horizon and edges
        var fgR=7/255,fgG=10/255,fgB=16/255,fo=0;
        fo=pGQ(sceneBuf,fo,0,0,fgR,fgG,fgB,.95,W,0,fgR,fgG,fgB,.95,W,H*.42,fgR,fgG,fgB,0,0,H*.42,fgR,fgG,fgB,0);
        fo=pGQ(sceneBuf,fo,0,0,fgR,fgG,fgB,.6,W*.1,0,fgR,fgG,fgB,0,W*.1,H,fgR,fgG,fgB,0,0,H,fgR,fgG,fgB,.6);
        fo=pGQ(sceneBuf,fo,W*.9,0,fgR,fgG,fgB,0,W,0,fgR,fgG,fgB,.6,W,H,fgR,fgG,fgB,.6,W*.9,H,fgR,fgG,fgB,0);
        sceneN=fo/S6;
        drawList.length=0;
        for(var i=0;i<buildings.length;i++){var b=buildings[i];var ne=b.z+b.d/2-cameraZ,fe=b.z-b.d/2-cameraZ;
          if(ne<-120||fe>FAR_PLANE)continue;if(!buildingInView(b))continue;
          b.drawDepth=buildingDrawDepth(b);b.drawHot=visualHot(b);drawList.push({type:"b",ref:b,depth:b.drawDepth});}
        for(var i=0;i<arcs.length;i++){var arc=arcs[i],el=now-arc.startedAt,tT=Math.min(1,el/arc.pulseDuration);
          var al=el<280?el/280:1;if(arc.arrivedAt){var fe2=now-arc.arrivedAt-arc.lifetime;if(fe2>0)al*=Math.max(0,1-fe2/500);}
          var sC=Math.max(3,Math.ceil(18*tT));
          for(var j=0;j<sC;j++){var t0=(j/sC)*tT,t1=((j+1)/sC)*tT,dep=arcSegmentDepth(arc,t0,t1);
            if(dep>NEAR_PLANE&&dep<FAR_PLANE)drawList.push({type:"as",ref:arc,depth:dep,t0:t0,t1:t1,alpha:al});}
          var dd=arcDotDepth(arc,tT);if(dd>NEAR_PLANE&&dd<FAR_PLANE)drawList.push({type:"ad",ref:arc,depth:dd});}
        drawList.sort(depthSortDesc);
        for(var i=0;i<drawList.length;i++){var it=drawList[i];
          if(it.type==="b"){if(projectBuilding(it.ref))buildBuildingGeometry(it.ref,now);}
          else if(it.type==="as")buildArcTrailSegment(it.ref,it.t0,it.t1,it.alpha);
          else buildArcDot(it.ref,now);}
  
        gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,Math.floor(W*dpr),Math.floor(H*dpr));
        gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);gl.disable(gl.DEPTH_TEST);
        if(overlayCanvas&&overlayCanvas.width>0){uploadTex(particleTex,overlayCanvas);gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
          gl.useProgram(progTex);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,particleTex);gl.uniform1i(texUT,0);drawFSQ(progTex,texAP);}
        uploadTex(gridTex,gridCanvas);gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
        gl.useProgram(progTex);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,gridTex);gl.uniform1i(texUT,0);drawFSQ(progTex,texAP);
        gl.useProgram(progMain);gl.uniform2f(mainUR,W,H);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);flushT(sceneBuf,sceneN,vbo,vaoMain);
        gl.useProgram(progPoint);gl.uniform2f(ptUR,W,H);gl.uniform1f(ptUD,dpr);flushP(pointBuf,pointN,ptVbo,vaoPt);
        if(screenBlendN>0){gl.useProgram(progMain);gl.uniform2f(mainUR,W,H);gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_COLOR);
          flushT(screenBlendBuf,screenBlendN,screenVbo,vaoScreen);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);}
        renderBloom();
        frameId=raf(frame);}
  
      function resize(w,h,nd){W=w;H=h;dpr=Math.min(nd||1,2);canvas.width=Math.floor(W*dpr);canvas.height=Math.floor(H*dpr);
        if(overlayCanvas){overlayCanvas.width=canvas.width;overlayCanvas.height=canvas.height;}
        gridCanvas.width=canvas.width;gridCanvas.height=canvas.height;
        if(gridCtx)gridCtx.setTransform(dpr,0,0,dpr,0,0);if(particleCtx)particleCtx.setTransform(dpr,0,0,dpr,0,0);
        HORIZON_Y=H*.32;generateParticles();drawParticles();gridCacheDirty=true;
        bloomW=Math.max(1,Math.floor(W*dpr/2));bloomH=Math.max(1,Math.floor(H*dpr/2));
        resizeFBO(gl,glowFBO,bloomW,bloomH);resizeFBO(gl,blurFBO,bloomW,bloomH);}
      function start(){if(!buildings.length)generateCity();running=true;lastTime=performance.now();smoothDelta=1/60;lastFrameTime=0;
        if(reducedMotion){frame(performance.now());stop();return;}if(frameId!==null)caf(frameId);frameId=raf(frame);}
      function stop(){running=false;if(frameId!==null){caf(frameId);frameId=null;}}
      function setVisibility(h){if(h)stop();else start();}function setThrottle(f){targetFPS=f||60;}
      resize(options.width||0,options.height||0,dpr);if(!options.hidden)start();
      return{resize:resize,start:start,stop:stop,setVisibility:setVisibility,setThrottle:setThrottle};}
  
    if(typeof document==="undefined"){var runtime=null;
      global.onmessage=function(e){var d=e.data||{};if(d.type==="init")runtime=createCityRuntime(d);
        else if(runtime&&d.type==="resize")runtime.resize(d.width,d.height,d.dpr);
        else if(runtime&&d.type==="visibility")runtime.setVisibility(d.hidden);
        else if(runtime&&d.type==="throttle")runtime.setThrottle(d.fps);};}
    else{global.initCityMainThread=createCityRuntime;}
  })(typeof self !== "undefined" ? self : window);