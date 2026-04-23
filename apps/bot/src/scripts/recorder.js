(function() {
    const config = {
        server_url: "http://transcription:6666/chunk",
        chunk_size: "30000",
    }
    function log(e){
        console.log("[Recorder Script]: ", e);
    }
    let audioconfig;
    let mediarecorder;
    function findMediaElement(){
        try{
            const element = document.querySelectorAll("audio");
            
        }catch(e){
            console.log(e)
        }
    }
})();