var modal_header_text = [];
var modal_content_html = [];

modal_header_text["about"] = "ABOUT";
modal_content_html["about"] = `

	<p>

	With the Ames History Museum Map, anyone can see and explore Ames at any time in
	its past, from the early 1860s, before the town was founded.
<br><br>
	Drag the time slider on the bottom to go to any time, click layers and 
	maps on the left panel, and move the vertical swipe in the middle to
	compare the data on different maps.
<br><br>
	Here is presented the things you might see on the maps 
	we've come to use:
	<br>
	The streets, railroads, buildings, and city limits, as well
	as properties, like what you'd see on a city or county website.
	The intention of this map is to show Ames as one would on Google Maps
	or Apple Maps, at any time in the past. It will become an indespensible 
	tool for understanding of the way thing were in the past, and 
	how they came to be in the present.
<br><br>
	The possibilities go much further - Dozens of layers can be added, including 
	the names of shops, important places, who lived where and owned which properties, 
	events and landmarks, and historic images, all connected to an encyclopedia. A 
	major addition will be historic maps, where people can compare the
	digital map to paper maps, side by side.
<br><br>
	Currently we have data from 2026, and have been able to develop the map
	using the dates properties were sold, and buildings were built, which
	are made available by the local tax assessors, as well as the county
	recorder and auditor, with mapping data provided by the GIS departments
	at the City of Ames and Story County.
	Future work would involve volunteers taking 
	historic maps and records, adding precise dates, showing changes of
	ownership, drawing changes and adding features.
<br><br>
	The map data varies in accuracy. Dates may not be exact, and few previous buildings so far have not been drawn. In some cases there are missing buildings and other features that currently exist. To understand the details of accuracy in each layer, click the Info button next to the layer names in the layers sidebar on the left.
<br><br>
	See the following map that was created for the Dutch Period in New
	York City, that begins to show how much further the work can go:
<br>
	<a href = 'https://nahc-mapping.org/mappingNY/' target="_blank">https://nahc-mapping.org/mappingNY/</a>
<br><br>
	Developed by Nitin Gadia.
<br>
	<a href = 'https://nittygrittymapping.com' target="_blank">nittygrittymapping.com</a>
<br><br>
	Seed funding provided by Bob Bourne.
	</p>
`;

modal_header_text["builds-info-layer"] = "Buildings";
modal_content_html["builds-info-layer"] = `
	<p>
		These are outlines of buildings in the Ames Area.
		Building dates come from the City of Ames Assessor's Department.
		The ages of a buildings are used to assess the property values of parcels, for property tax collection.
		<br><br>
		These are existing buildings, not ones that have been demolished in the past, or how they've
		looked if they changed shape since they were first contructed.
		<br><br>
		Only one previous building has so far been drawn to demonstrate: The "Field House" was a building of historic importance,
		on the Iowa State Central Campus. Zoom into the Iowa State Central Campus by Wallace and Beach Avenue
		to see it appear in 1920 and be demolished in 1953.
		The outline of the Field House for example overlaps a building that was expanded since it was demolished, and the
		surroundings have changed with the roads and paths since.

		<br><br>

		Future work across the map would involve correcting dates, and drawing buildings that existed in the past, and draw
		the changes that took place with buildings, roads and other features, by georeferencing older maps.

		<br><br>
		More notes on Accuracy:
		<br><br>
		*With Assessor's data, dates of old buildings are often guessed, often to the nearest decade. This is because clear records
		don't always exist, and beyond a certain age, the effect on property values does not change significantly.
		<br><br>
		*Some parcels have more than one building that were built in different years, and
		the buildings take one of the dates. Future effort would need
		to apply correct build dates using Assessor data and historic records.

		<!--
		<br><br>
		Citation:
		<br>
		[]
		-->
	</p>
`;

modal_header_text["roads-info-layer"] = "Roads";
modal_content_html["roads-info-layer"] = `
	<p>
		Dates covered so far: 1865-2026
		<br><br>
		Finding the dates roads were built in Ames is a multilayered process, involving
		taking subdivision dates and using maps and other historic records for confirmation,
		as well as manually deciding dates. Existing road lines are used, but their paths
		may have changed since they were originally constructed, and some roads existed in the
		past, that would require research and drawing.
<br><br>
		"Subdivision Roads":
		<br>
		Dates of a local road is usually between the creation of the subdivision
		it was within, and when the buildings were built.
		As you move the time slider, all of the roads appear at the time the subdivision was created,
		and you see the buildings appearing along the roads.
		The actual time the road would be created is usually before buildings were built
		along it, sometimes years apart. If a subdivision was created in 1990 for example,
		it might not be until 1993 that all the roads are built, and you see all the buildings
		fill along the roads.
		Further work would involve creating another layer
		where roads are manually chosen based on their earliest buildings.
		<br>
		See the layers "Subdivisions" for more information and comparison.
<br><br>
		"Confirmed Roads"
<br>
		The dates that roads were built by can be confirmed using maps and historic records.
		Historic maps are georeferenced, and would be added as a layer, and used to
		confirm roads.
		If there are two maps, for example, from 1900 and 1910, we can confirm that the
		new roads were built by 1910, even though they may have been built in 1901.
		Future work would involve georeferencing old maps, and add to this layer.
		Additional records should be searched for that might give the dates roads were
		created or paved, such as the public works department.


		<!--
		<br><br>
		Citation:
		<br>
		[]
		-->
	</p>
`;

modal_header_text["parcels-info-layer"] = "Parcels";
modal_content_html["parcels-info-layer"] = `
	<p>
		Parcels, or land properties, were mostly created with subdivisions, 
		usually by developers, and sold individually
		to property owners. Outside of subdivisions, parcels were created
		by the Federal Government and sold as land patents, and were often
		divided by property owners.
		<br><br>
		Future work would involve adding owners to parcels and finding
		any divisions and merges of properties, mainly using
		digital data and grantor-grantee indexes from the Story County
		Recorder and Auditor.
		<br><br>
		See the "Subdivisions", "Pre-Subdivisions", and
		"Story County Land Patents" layers for more information.

		<!--
		<br><br>
		Citation:
		<br>
		[]
		-->
	</p>
`;

modal_header_text["pre-subdivisions-info-layer"] = "Pre-Subdivisions";
modal_content_html["pre-subdivisions-info-layer"] = `
	<p>
		This layer shows rural parcel divisions and ownership transfers
		that happened after the first land patents,
		and before subdivisions were created for urban settlements and expansion.
		<br>Mouse over the properties, and you can see who owned the parcels by
		hovering over and clicking on them.

		<br><br>
		Here, only the parcels were focused on in the area of what became Ames,
		before 1865. You can see the properties owned by John Blair and Cynthia
		Duff, who were instrumental in the founding of Ames, as their properties
		were sold to create the first subdivision of Ames.
		<br>
		<br>
		This required finding records from the Story County Recorder, which
		had Deed Grantor and Grantee Indexes that described the properties
		according to the PLSS System.
		Ultimately, all of the divisions and changes of ownership can 
		be done like they were here, across the area of Ames today, or across
		Story County.

		
		<br><br>
		See "Story County Land Patents" and "Subdivisions" layers to see
		what came before and after.
	</p>
`;

modal_header_text["story-patents-info-layer"] = "Story County Land Patents";
modal_content_html["story-patents-info-layer"] = `
	<p>
		Most of the United States was divided into a grid, called the "Public Land
		Survey System", where parcels were sold as original "Land Patents".
		Story County was almost entirely bought up and settled between 1850-1865.
		At the end of the period, the first subdivision was created in Ames,
		and the town was founded.
		<br><br>
		See the "Pre-Subdivisions" layer for more information on what came after.

		<!--
		<br><br>
		Citation:
		<br>
		[]
		-->
	</p>

	</p>
`;

modal_header_text["subdivisions-info-layer"] = "Subdivisions";
modal_content_html["subdivisions-info-layer"] = `
	<p>
		Subdivisions are the basis of modern land development. 
		Land is purchased from property owners, and subdivided into
		parcels that are either built or sold as empty
		lots. Parcels are created at the time a subdivision is approved
		by the City or County government.
<br><br>
		The first subdivision in Ames was created in 1864, and
		the town was incorporated shortly after.
		<br>
		See the "Pre-Subdivisions" layer and "Story County Land Patents"
		for what came before and after.

		<!--
		<br><br>
		Citation:
		<br>
		[]
		-->


	</p>
`;

modal_header_text["rail-roads-info-layer"] = "Railroads";
modal_content_html["rail-roads-info-layer"] = `
	<p>
		Ames was founded as a railroad town, when the Cedar Rapids and Missouri River Railroad contructed a stop in 1864,
		going from Cedar Rapids to Council Bluffs on the Iowa-Nebraska border.
		An additional line was built by 1882 by the Chicago & North Western Railroad, going north from Ames to Albert Lea, on the
		border with Minnesota.

		<!--
		<br><br>
		Citation:
		<br>
		[]
		-->


	</p>
`;

modal_header_text["city-limits-info-layer"] = "City limits";
modal_content_html["city-limits-info-layer"] = `
	<p>
		The city limits of Ames, from 1960 onward. Going earlier will require further research,
		using old maps and land descriptions. Much of the expansion of the town can often be approximated
		by the "subdivisions" layer as well, which usually come during or after city limits expand,
		to make was for them.

		<!--
		<br><br>
		Citation:
		<br>
		[]
		-->
	</p>
`;
