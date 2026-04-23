(function() {
    const config = {
        server_url: "http://transcription:6666/chunk",
        chunk_size: "30000",
    }
    function log(e){
        console.log("[Recorder Script]: ", e);
    }
    let audiocontext;
    let mediarecorder;
    let dest;
    function findMediaElement(){
        try{
            const element = document.querySelectorAll("audio");
            if(element.length == 0){
                log("no media element found");
                return null;
            }
            return element;
        }catch(e){
            console.log(e)
        }
    }

    function mergeMediaElement(mediaElements){
        try{
            audiocontext = new AudioContext();
            dest = audiocontext.createMediaStreamDestination();
            mediaElements.forEach((ele) => {
                let mediaStream = ele.srcObject;
                if(mediaStream instanceof MediaStream && mediaStream.getAudioTracks().length > 0){
                    let source = audiocontext.createMediaStreamSource(mediaStream);
                    source.connect(dest);
                }
            })
        }catch(e){
            log(e);
        }
    }
})();