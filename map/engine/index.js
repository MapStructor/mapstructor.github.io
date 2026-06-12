
var layer_view_flag = true;
var timeline_pointer_flag = true;
var windoWidth = 0;

var sliderStart = moment(sliderStartDate).unix();
var sliderStartDrag = sliderStart;
var sliderEnd = moment(sliderEndDate).unix();
var sliderEndDrag = sliderEnd;
var sliderMiddle = (sliderStart + sliderEnd) / 2;
var tooltiPos = -100;

var ruler_step = (sliderEnd - sliderStart) / 10,
  date_ruler1 = sliderStart + ruler_step,
  date_ruler2 = sliderStart + ruler_step * 3,
  date_ruler4 = sliderStart + ruler_step * 7,
  date_ruler5 = sliderStart + ruler_step * 9;

function simple_tooltip(target_items, name) {
  $(target_items).each(function (i) {
    $("body").append(
      "<div class='" +
        name +
        "' id='" +
        name +
        i +
        "'><p>" +
        $(this).attr("title") +
        "</p></div>"
    );
    var my_tooltip = $("#" + name + i);

    $(this)
      .removeAttr("title")
      .mouseover(function () {
        my_tooltip.css({ opacity: 1.0, display: "none" }).fadeIn(200);
      })
      .mousemove(function (kmouse) {
        my_tooltip.css({ left: kmouse.pageX + 15, top: kmouse.pageY + 15 });
      })
      .mouseout(function () {
        my_tooltip.fadeOut(200);
      });
  });
}

$(document).ready(function () {
  $("#logo-link").attr("href", siteLogoLink);
  $("#header-text-value").text(siteHeaderText);

  headerButtons.forEach(btn => {
    let el;
    if (btn.type === "modal") {
      el = $(`<label class="trigger-popup header-btn" id="${btn.id}">${btn.label}</label>`);
    } else {
      const target = btn.newTab === false ? "_self" : "_blank";
      el = $(`<a href="${btn.url}" target="${target}" class="header-btn">${btn.label}</a>`);
    }
    $("#header-right-buttons").append(el);
  });

if (jQuery.browser.msie)
    alert(
      "Sorry, this application uses state of the art HTML5 techniques which are not (well) supported by Internet Explorer.\nUse Google Chrome or Mozilla Firefox to experience the full power of HTML5 and this application"
    );

  simple_tooltip("i.layer-info, i.zoom-to-layer", "tooltip");

  windoWidth = $(window).width();
  if (windoWidth <= 637) {
    if (layer_view_flag) {
      $("#studioMenu").css({ "margin-left": "-111%" });
      $("#view-hide-layer-panel").css({ "margin-left": "-337px" });
      $("#mobi-hide-sidebar").css({ "margin-left": "-111%" });
      layer_view_flag = false;
      $("#dir-txt").html("&#9205;");
    }
  }

  $(window).resize(function () {
    windoWidth = $(window).width();
  });



  $("#ruler-date1").text(moment.unix(date_ruler1).format("YYYY"));
  $("#ruler-date2").text(moment.unix(date_ruler2).format("YYYY"));
  $("#ruler-date3").html(
    "&nbsp; &#8678; &nbsp; TIME &nbsp; &nbsp; &nbsp; &nbsp; SLIDE &nbsp; &#8680;"
  );
  $("#mobi-year").html(
    "&nbsp; &#8678; &nbsp; TIME &nbsp; &nbsp; &nbsp; &nbsp; SLIDE &nbsp; &#8680;"
  );
  $("#ruler-date4").text(moment.unix(date_ruler4).format("YYYY"));
  $("#ruler-date5").text(moment.unix(date_ruler5).format("YYYY"));

  $("#slider").slider({
    min: sliderStart,
    max: sliderEnd,
    step: 86400,
    value: sliderMiddle,
    slide: function (event, ui) {
      tooltiPos = ui.value < sliderMiddle ? 30 : -100;

      if (timeline_pointer_flag) {
        $("#ruler-date3").text(moment.unix(sliderMiddle).format("YYYY"));
        $("#mobi-year").css("display", "none");
        $("#ruler-date1").css("display", "block");
        $("#ruler-date2").css("display", "block");
        $("#ruler-date3").css("display", "block");
        $("#ruler-date4").css("display", "block");
        $("#ruler-date5").css("display", "block");
        timeline_pointer_flag = false;
      }

     
       changeDate(ui.value);
       $("#date").text(moment.unix(ui.value).format("DD MMM YYYY"));
      
    },
    create: function (event, ui) {
      var tooltip = $('<div class="ui-slider-tooltip" />')
        .css({
          position: "absolute",
          top: 32,
          left: tooltiPos,
          color: "red",
          width: "100px",
          size: "1",
        })
        .text(moment.unix(sliderMiddle).format("MM/DD/YYYY"));
    },
    change: function (event, ui) {},
  });
  $("#date").text(
    moment.unix($("#slider").slider("values", 0)).format("DD MMM YYYY")
  );

  $(".footnote").click(function () {
    $("#footnotediv").toggle("slide");
  });

  
 



  /* change timeline CSS property on mouseover & mouseout */
  $("div.timeline")
    .mouseover(function () {
      $("div.ui-widget-content").css("background-color", "#baddf9");
      $("a.ui-slider-handle").css("background", "red");
    })
    .mouseout(function () {
      $("div.ui-widget-content").css("background-color", "#d1ecff");
      $("a.ui-slider-handle").css("background", "");
    });

  $(".trigger-popup").click(function (e) {
    var popup_id =
      e.target.id == "info" || e.target.id == "about-info"
        ? "about"
        : e.target.id;

	console.log(popup_id);
	//if(popup_id == "about") { }
	if(typeof modal_header_text[popup_id] !== 'undefined') { 
		if (modal_header_text[popup_id].length > 0) {
			$("div.modal-header h1").text(modal_header_text[popup_id]);
			$("div.modal-content").html(modal_content_html[popup_id]);
			$("label#open-popup").trigger("click");
		}
	}
	
	
  });

  // close modal by click outside the box

  $("div.modal-body").click(function (e) {
    e.stopPropagation();
  });

  $("div.modal").click(function () {
    $("label#close").trigger("click");
  });

  setTimeout(function () {
    $("div#loading").css("display", "none");
  }, 5000);
  
 

  $("#view-hide-layer-panel").click(function () {
    if (layer_view_flag) {
      $("#studioMenu").animate({ "margin-left": "-337px" }, 500);
      $(this).animate({ "margin-left": "-337px" }, 500);
      $("#mobi-hide-sidebar").animate({ "margin-left": "-337px" }, 500);
      layer_view_flag = false;
      $("#dir-txt").html("&#9205;");
      $("#rightInfoBar").slideUp();
    } else {
      $("#studioMenu").animate({ "margin-left": "0px" }, 500);
      $(this).animate({ "margin-left": "0px" }, 500);
      $("#mobi-hide-sidebar").animate({ "margin-left": "0px" }, 500);
      layer_view_flag = true;
      $("#dir-txt").html("&#9204;");
      if (windoWidth > 637) $("#rightInfoBar").slideDown();
    }
  });

  $("#mobi-view-sidebar").click(function () {
    if (!layer_view_flag) {
      $("#studioMenu").animate({ "margin-left": "0px" }, 500);
      $("#view-hide-layer-panel").animate({ "margin-left": "0px" }, 500);
      $("#mobi-hide-sidebar").animate({ "margin-left": "0px" }, 500);
      layer_view_flag = true;
      $("#dir-txt").html("&#9204;");
    }
  });

  $("#mobi-hide-sidebar").click(function () {
    if (layer_view_flag) {
      $("#studioMenu").animate({ "margin-left": "-111%" }, 500);
      $("#view-hide-layer-panel").animate({ "margin-left": "-337px" }, 500);
      $(this).animate({ "margin-left": "-111%" }, 500);
      layer_view_flag = false;
      $("#dir-txt").html("&#9205;");
    }
  });
  
});





